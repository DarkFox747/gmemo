# Design: Dev Harness (locally runnable & testable MCP server)

schema: design-v1
change: dev-harness
status: draft
author: crombie-architect
depends_on: scaffold-runtime-mcp-facade, auth-two-gate, data-model (all archived)

## Technical Approach

The read path is code-complete but, after `auth-two-gate`, boot now hard-requires a
Cognito user pool + a live Postgres, so the server can no longer run standalone. This
change makes it runnable end-to-end with one `docker compose up` by stubbing **only Gate 1
(Cognito)** behind a hard production guard, while keeping Gate 2, RBAC, and audit **real**
against a local `postgres:16`.

The mechanism is entirely additive and lives at the composition root:

- A new `DevAuthenticator implements Authenticator` returns a FIXED `Principal` whose
  `subject` equals a seeded `app_user.idp_subject`. Because the seam contract is unchanged,
  `RdsTenantResolver` + `RdsAuthorizer` + `RdsAuditLogger` run unmodified against the seeded
  DB — Gate 2 (user + membership), RBAC role derivation, and `access_log` writes are all
  genuinely exercised.
- `src/config/index.ts` gains `AUTH_DEV_BYPASS`, makes `COGNITO_*` conditional, and grows a
  `.superRefine` that is the **load-bearing prod guard**: `AUTH_DEV_BYPASS=true` +
  `NODE_ENV=production` refuses to load.
- `src/index.ts` selects `DevAuthenticator` vs `CognitoAuthenticator` from config; nothing
  else in `AppServices` changes.
- Sample data is seeded via `migrations/seed.dev.sql`, applied by a **guarded dev-only
  runner** (`src/db/seed.ts`, refuses under `NODE_ENV=production`) that is NOT part of the
  forward-only migration runner. The migration runner is tightened to numbered files only so
  the seed can never be picked up in prod.
- A multi-stage, non-root, pnpm-only `Dockerfile` + `docker-compose.yml` wire app + db +
  a one-shot migrate/seed step, with a `/health` healthcheck.

No new runtime dependencies (YAGNI): Docker/compose/SQL and existing `zod`/`pg` only.

## Architecture Decisions

### Decision: Stub ONLY Gate 1 via a new `Authenticator` implementation

**Choice**: Add `src/auth/devAuthenticator.ts` implementing the existing seam:

```ts
// src/mcp/context.ts (quoted — the seam DevAuthenticator must satisfy)
export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}
export interface Principal {
  subject: string;   // JWT `sub` → app_user.idp_subject after Gate 2
  clientId: string;  // Cognito client_id (audience-equivalent)
  scopes: string[];  // space-split access-token scopes
}
```

```ts
// src/auth/devAuthenticator.ts  — DEV-ONLY. See loud comment in the file.
/**
 * ⚠️  DEV-ONLY GATE-1 STUB — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DevAuthenticator bypasses Cognito entirely and returns a FIXED Principal
 * regardless of the Authorization header (the arg is intentionally ignored).
 * It is chosen at the composition root ONLY when AUTH_DEV_BYPASS=true AND
 * NODE_ENV !== 'production'. config.loadConfig() fails fast if that pairing is
 * ever attempted in production, so this class can never run there.
 *
 * The returned `subject` MUST equal the seeded app_user.idp_subject in
 * migrations/seed.dev.sql, otherwise the REAL Gate 2 (RdsAuthorizer) denies
 * every request. Everything downstream (tenant resolve, RBAC, audit) is REAL.
 */
import type { Authenticator, Principal } from '../mcp/context.js';

/** Fixed identity — kept in lockstep with migrations/seed.dev.sql. */
export const DEV_PRINCIPAL: Principal = {
  subject: 'dev-local-user',           // == app_user.idp_subject (seed)
  clientId: 'dev-local-client',        // not consumed by Gate 2 / RBAC
  scopes: ['lpms.memory/read'],        // representative; Authorizer ignores scopes
};

export class DevAuthenticator implements Authenticator {
  // eslint-disable-next-line @typescript-eslint/require-await
  async authenticate(_authorization: string | undefined): Promise<Principal> {
    // No token verification. Returns the fixed dev principal unconditionally.
    return DEV_PRINCIPAL;
  }
}
```

**Alternatives considered**:
- *Full auth bypass* (stub Gate 2/RBAC/audit too) — leaves the enforcement code untested
  locally and puts a fake-data path next to real enforcement.
- *Locally-signed test JWT + real `CognitoJwtVerifier`* — needs a local JWKS/key server and
  pins local dev to Cognito token internals; strictly heavier.

**Rationale**: `subject` is the only field Gate 2 consumes (`findEnabledUserBySubject` →
`findMembershipRole`), so matching it to a seeded `app_user` exercises the maximal real code
path. `clientId`/`scopes` are inert downstream (`RdsAuthorizer` derives roles from RDS, never
from token claims), so a representative constant is safe and honest. Implementing the seam
means zero handler/interface change (D3).

### Decision: Config `.superRefine` prod guard is the single load-bearing control

**Choice**: Add `AUTH_DEV_BYPASS` (safe boolean), make `COGNITO_*` optional at the field
level, and enforce requiredness + the prod guard in one `.superRefine`.

**Alternatives considered**: `z.coerce.boolean()` for the flag (rejected — any non-empty
string, including `"false"`, coerces to `true`); a runtime `if` in `index.ts` only (rejected —
the config layer is the fail-fast boundary and where tests assert the guard).

**Rationale**: Centralizing the guard in `loadConfig()` means the process refuses to *load*
config in the forbidden pairing — it never reaches `createApp`/`listen`. `index.ts` then adds
a second, independent `NODE_ENV !== 'production'` check (defense in depth). The `enum` boolean
avoids the classic coercion footgun.

### Decision: Dev seed via a guarded runner, NOT the migration runner

**Choice**: `migrations/seed.dev.sql` is applied only by a new `src/db/seed.ts` that refuses
under `NODE_ENV=production`. Separately, tighten `src/db/migrate.ts` so it applies **numbered
migrations only** (`/^\d{4}_.*\.sql$/`), excluding `seed.dev.sql`.

**Alternatives considered**: Seeding through the app write tools (rejected — the write path
does not exist yet); placing the seed under a subdirectory to dodge the glob (rejected — the
task pins the path to `migrations/seed.dev.sql`, and relying on non-recursive `readdir` is a
fragile, implicit guarantee).

**Rationale**: `migrate.ts` currently globs `migrations/*.sql` and applies *everything* — so a
`migrations/seed.dev.sql` **would be applied by `pnpm migrate` in production**, silently
shipping dev data. The numbered-only filter makes the "migrations are numbered; seeds are not"
convention explicit and machine-enforced. Two independent barriers now protect prod: the
runner ignores the file, and the seed runner refuses under `NODE_ENV=production`.

### Decision: Multi-stage image runs compiled JS; pnpm/tsx only in the builder

**Choice**: Builder installs with `pnpm install --frozen-lockfile`, runs `pnpm build`, then
`pnpm prune --prod`. Runtime copies `dist/`, pruned `node_modules/`, `package.json`, and
`migrations/`, runs as the `node` user, and executes `node dist/...` directly (no pnpm, no tsx
at runtime). Migrate/seed run as `node dist/db/migrate.js` / `node dist/db/seed.js`.

**Alternatives considered**: Running `pnpm migrate`/`pnpm seed:dev` (tsx) inside the container
(rejected — `tsx` is a devDependency, pruned from the runtime image; keeping it would bloat the
image and widen the attack surface).

**Rationale**: `tsc` already emits `dist/db/migrate.js` and `dist/db/seed.js` (rootDir `src`,
outDir `dist`), so the compiled entrypoints exist for free. The runtime image carries no build
toolchain, no source, no `.env`, and runs non-root — prod-safe by default even though local
compose flips `NODE_ENV=development`.

## Data Flow

Request path under the dev bypass (only the first box changes; the rest is REAL):

    POST /mcp                 X-Git-Remote: <seeded remote_url>
      │  (Authorization header ignored under bypass)
      ▼
    DevAuthenticator ──▶ Principal{subject:'dev-local-user'}   ← STUB (Gate 1)
      │
      ▼
    RdsTenantResolver ─▶ repo(remote_url) ─▶ TenantContext{project,repo,branch}   ← REAL
      │
      ▼
    RdsAuthorizer ─▶ app_user(idp_subject='dev-local-user') + project_membership   ← REAL
      │                 └▶ ActorIdentity{actorId:'dev-local-user', roles:['viewer']}
      ▼
    handler (recall / get_memory / get_context) ─▶ PgMemoryRepository ─▶ seeded memory rows   ← REAL
      │
      ▼
    RdsAuditLogger ─▶ access_log row   ← REAL

Boot / composition-root switch:

    loadConfig()  ── superRefine ──▶  { AUTH_DEV_BYPASS && NODE_ENV==='production' }  ─▶  FAIL FAST (exit 1)
        │
        ├─ AUTH_DEV_BYPASS && NODE_ENV!=='production' ─▶ new DevAuthenticator()      (loud WARN banner)
        └─ else ─▶ CognitoJwtVerifier.create(...) ─▶ new CognitoAuthenticator(v)      (default)

## Config changes — exact zod edits (`src/config/index.ts`)

Resulting schema shape (`.object(...).superRefine(...)`):

```ts
import { z } from 'zod';

const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Database
    DATABASE_URL: z.string().min(1),

    // Dev harness — Gate-1 bypass flag. Safe boolean (NOT z.coerce.boolean,
    // which treats "false" as true). Guarded in superRefine below.
    AUTH_DEV_BYPASS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Cognito — Gate 1. OPTIONAL at the field level; REQUIRED by superRefine
    // only on the real path (AUTH_DEV_BYPASS !== true).
    COGNITO_USER_POOL_ID: z.string().min(1).optional(),
    COGNITO_CLIENT_ID_ALLOWLIST: z
      .string()
      .min(1)
      .transform((s) => s.split(',').map((id) => id.trim()).filter(Boolean))
      .refine((arr) => arr.length > 0, {
        message: 'COGNITO_CLIENT_ID_ALLOWLIST must contain at least one client ID',
      })
      .optional(),
    COGNITO_REQUIRED_SCOPE: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    // ── LOAD-BEARING PROD GUARD (D2) ─────────────────────────────────────
    // The dev auth bypass MUST be impossible in production. Fail to load.
    if (cfg.AUTH_DEV_BYPASS && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_DEV_BYPASS'],
        message:
          'AUTH_DEV_BYPASS=true is forbidden when NODE_ENV=production — ' +
          'the dev auth bypass cannot run in production.',
      });
    }

    // ── Real Cognito path requires its vars (D3) ─────────────────────────
    if (!cfg.AUTH_DEV_BYPASS) {
      if (!cfg.COGNITO_USER_POOL_ID) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COGNITO_USER_POOL_ID'],
          message: 'COGNITO_USER_POOL_ID is required when AUTH_DEV_BYPASS is not true.' });
      }
      if (!cfg.COGNITO_CLIENT_ID_ALLOWLIST) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COGNITO_CLIENT_ID_ALLOWLIST'],
          message: 'COGNITO_CLIENT_ID_ALLOWLIST is required when AUTH_DEV_BYPASS is not true.' });
      }
      if (!cfg.COGNITO_REQUIRED_SCOPE) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COGNITO_REQUIRED_SCOPE'],
          message: 'COGNITO_REQUIRED_SCOPE is required when AUTH_DEV_BYPASS is not true.' });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;
// loadConfig() body is UNCHANGED: safeParse → on !success console.error + process.exit(1).
```

Notes:
- Transform ordering: `AUTH_DEV_BYPASS` is a `boolean` and `COGNITO_CLIENT_ID_ALLOWLIST` is
  `string[] | undefined` inside `superRefine` (transforms run first). No change to
  `loadConfig()` itself — it still `safeParse`s and `process.exit(1)`s on failure.
- `COGNITO_*` become `string | undefined` in the `Config` type; `index.ts` narrows on the real
  path (see below).

## index.ts switch — exact boot-DI change

Replace the unconditional Cognito block (current lines 41–52 + the `authenticator:` field on
line 68) with a config-driven branch. Everything else in `AppServices` is untouched.

```ts
import { DevAuthenticator } from './auth/devAuthenticator.js';
// (existing imports: CognitoJwtVerifier, CognitoAuthenticator, etc.)

// --- 4. Gate-1 authenticator: dev stub vs real Cognito (composition root) ---
let authenticator: import('./mcp/context.js').Authenticator;

if (config.AUTH_DEV_BYPASS && config.NODE_ENV !== 'production') {
  // Defense in depth: loadConfig() already fails fast on the prod pairing;
  // this second check keeps the stub structurally unreachable in production.
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] AUTH_DEV_BYPASS ACTIVE — Gate 1 (Cognito) is STUBBED.');
  logger.warn('[boot] DevAuthenticator returns a FIXED principal. DEV ONLY.');
  logger.warn('[boot] Gate 2 (RDS user+membership), RBAC and audit remain REAL.');
  logger.warn('════════════════════════════════════════════════════════════');
  authenticator = new DevAuthenticator();
} else {
  // Real path. superRefine guarantees these are present here; the explicit
  // guard satisfies the type-checker (COGNITO_* are optional in Config).
  if (
    !config.COGNITO_USER_POOL_ID ||
    !config.COGNITO_CLIENT_ID_ALLOWLIST ||
    !config.COGNITO_REQUIRED_SCOPE
  ) {
    throw new Error('[boot] Cognito configuration missing on the real auth path');
  }
  const cognitoVerifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    tokenUse: 'access',
    clientId: config.COGNITO_CLIENT_ID_ALLOWLIST,
    scope: config.COGNITO_REQUIRED_SCOPE,
  });
  cognitoVerifier.hydrate().catch((err: unknown) => {
    logger.warn('[boot] Cognito JWKS pre-fetch failed (non-fatal; retries on first verify)', err);
  });
  authenticator = new CognitoAuthenticator(cognitoVerifier);
}

const services: AppServices = {
  authenticator,                                   // ← only line that changed
  tenantResolver: new RdsTenantResolver(authRepository),
  authorizer: new RdsAuthorizer(authRepository),
  auditLogger: new RdsAuditLogger(authRepository),
  memoryRepository,
};
```

## Seed — `migrations/seed.dev.sql` (exact INSERTs) + dev-only application

Honors 0001/0002 FKs, enums, and CHECK budgets; never lists the generated `content_tsv`
column; fully idempotent via `ON CONFLICT`.

```sql
-- migrations/seed.dev.sql
-- DEV-ONLY sample data. Applied by `pnpm seed:dev` (src/db/seed.ts), which REFUSES
-- when NODE_ENV=production. NOT applied by the migration runner (numbered-only).
-- Idempotent: safe to re-run. Fixed UUIDs keep FKs stable across runs.

-- 1) app_user — idp_subject MUST equal DevAuthenticator DEV_PRINCIPAL.subject.
INSERT INTO app_user (id, idp_subject, email, display_name, global_role)
VALUES ('00000000-0000-0000-0000-000000000001',
        'dev-local-user', 'dev@localhost', 'Local Dev User', NULL)
ON CONFLICT (idp_subject) DO NOTHING;

-- 2) project
INSERT INTO project (id, slug, name, created_by)
VALUES ('00000000-0000-0000-0000-000000000010',
        'lpms-cloud', 'LPMS Cloud (local dev)',
        '00000000-0000-0000-0000-000000000001')
ON CONFLICT (slug) DO NOTHING;

-- 3) repo — remote_url is the X-Git-Remote value clients must send.
INSERT INTO repo (id, project_id, remote_url, provider, slug, default_branch)
VALUES ('00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000010',
        'https://github.com/crombie-dev/lpms-cloud.git',
        'github', 'lpms-cloud', 'main')
ON CONFLICT (remote_url) DO NOTHING;

-- 4) project_membership — viewer is sufficient for all read tools.
INSERT INTO project_membership (id, project_id, user_id, role, granted_by)
VALUES ('00000000-0000-0000-0000-000000000030',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001',
        'viewer', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- 5) memory rows — one each: constraint, domain_rule, decision, gotcha.
--    content_tsv is GENERATED — do NOT insert it. provenance NOT NULL.
--    Budgets: title<=120, summary<=200, body<=2000. content_hash unique per project.
INSERT INTO memory
  (id, project_id, repo_id, type, title, summary, body,
   provenance, author_identity, content_hash)
VALUES
  ('00000000-0000-0000-0000-000000000040',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'constraint',
   'Use pnpm only — npm/yarn/bun are blocked',
   'All installs must use pnpm with a frozen lockfile; other package managers are forbidden.',
   'The repo pins packageManager pnpm@9.15.0 and enforces it via engines + .npmrc engine-strict + a guard hook. Agents run `pnpm install --frozen-lockfile`; humans add deps out-of-band and commit pnpm-lock.yaml.',
   'manual_ui', 'dev-seed', 'seed-constraint-0001'),
  ('00000000-0000-0000-0000-000000000041',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'domain_rule',
   'Agents READ and PROPOSE only — writes go to staging',
   'remember() always writes to staging; promotion to main happens only via PR merge or Web UI.',
   'The MCP facade never lets an agent write directly to authoritative memory. All writes buffer in a staging session keyed by (project, repo, branch); a judge gates promotion. Reads require viewer+; writes require contributor/service_agent.',
   'manual_ui', 'dev-seed', 'seed-domainrule-0002'),
  ('00000000-0000-0000-0000-000000000042',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'decision',
   'FTS uses the english dictionary (not simple)',
   'content_tsv is generated with to_tsvector(''english'', ...) weighted A/B/C over title/summary/body.',
   'Decided before any data was written (migration 0002). The english dictionary gives stemming for BM25-style recall; weights are title=A, summary=B, body=C. This is the only deviation from schema v2, which used ''simple''.',
   'manual_ui', 'dev-seed', 'seed-decision-0003'),
  ('00000000-0000-0000-0000-000000000043',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'gotcha',
   'The dev auth bypass must never reach production',
   'AUTH_DEV_BYPASS=true with NODE_ENV=production fails fast at boot; default is real Cognito.',
   'DevAuthenticator stubs Gate 1 only. The config superRefine refuses to load in the forbidden pairing and index.ts adds a second NODE_ENV guard. Gate 2, RBAC and audit stay real against local Postgres.',
   'manual_ui', 'dev-seed', 'seed-gotcha-0004')
ON CONFLICT (project_id, content_hash) DO NOTHING;
```

Guarded dev-only runner:

```ts
// src/db/seed.ts — DEV-ONLY seed runner. Refuses under NODE_ENV=production.
// Run via `pnpm seed:dev` (local, tsx) or `node dist/db/seed.js` (container).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, closePool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(__dirname, '..', '..', 'migrations', 'seed.dev.sql');

export async function runSeed(connectionString: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('[seed] Refusing to seed: NODE_ENV=production. Dev seed is never applied in prod.');
    process.exit(1);
  }
  const pool = createPool(connectionString, false); // local dev: no TLS enforcement
  const client = await pool.connect();
  try {
    const sql = await fs.readFile(SEED_FILE, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[seed] Dev seed applied (idempotent).');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[seed] Failed:', err);
      throw err;
    }
  } finally {
    client.release();
    await closePool(pool);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed(process.env.DATABASE_URL ?? '').catch(() => process.exit(1));
}
```

Migration-runner hardening (`src/db/migrate.ts`) — tighten the file filter so the seed can
never be applied by the prod migrate path:

```ts
// BEFORE: .filter((f) => f.endsWith('.sql'))
// AFTER:  numbered migrations only — excludes seed.dev.sql and any non-migration .sql
files = (await fs.readdir(MIGRATIONS_DIR))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
```

`package.json` gains one script (no dependency changes):

```jsonc
"seed:dev": "tsx src/db/seed.ts"
```

## Dockerfile (multi-stage, pnpm, non-root)

```dockerfile
# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod          # drop devDeps (tsx, tsc, vitest, ...) → prod node_modules

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production        # prod-safe default; compose overrides to development locally
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY migrations ./migrations    # needed by dist/db/migrate.js and dist/db/seed.js
USER node                       # non-root (uid 1000 ships with node:alpine)
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

`.dockerignore`:

```
node_modules
dist
.git
.gitignore
tests
openspec
docs
coverage
.env
.env.*
*.log
npm-debug.log*
Dockerfile
docker-compose.yml
.dockerignore
```

## docker-compose.yml

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: lpms
      POSTGRES_PASSWORD: lpms
      POSTGRES_DB: lpms
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lpms -d lpms"]
      interval: 5s
      timeout: 3s
      retries: 10
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"        # optional: host access for debugging

  # One-shot: apply numbered migrations, then the dev seed. Runs compiled JS
  # (no tsx in the image). Exits 0 on success; app waits for completion.
  migrate:
    build: .
    command: ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js"]
    environment:
      DATABASE_URL: "postgres://lpms:lpms@db:5432/lpms"   # no sslmode → local plaintext
      NODE_ENV: development                                # required for seed.js to proceed
    depends_on:
      db:
        condition: service_healthy
    restart: "no"

  app:
    build: .
    environment:
      DATABASE_URL: "postgres://lpms:lpms@db:5432/lpms"    # local, TLS not enforced (NODE_ENV!=production)
      NODE_ENV: development
      AUTH_DEV_BYPASS: "true"        # Gate-1 stub; guarded — impossible under NODE_ENV=production
      PORT: "3000"
      HOST: "0.0.0.0"
      LOG_LEVEL: debug
      # COGNITO_* intentionally omitted — optional under the dev bypass.
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    ports:
      - "3000:3000"
    healthcheck:
      # busybox wget ships in node:alpine; hits GET /health.
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

X-Git-Remote guidance: clients must send `X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git`
(the seeded `repo.remote_url`) or `RdsTenantResolver` returns PERMISSION_DENIED.

## .env.dev.example

```dotenv
# Local dev harness — copy to .env, then `docker compose up --build`.
# For running the app OUTSIDE docker, point DATABASE_URL at localhost.
DATABASE_URL=postgres://lpms:lpms@localhost:5432/lpms
AUTH_DEV_BYPASS=true
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=debug

# COGNITO_* are NOT required while AUTH_DEV_BYPASS=true.

# When calling POST /mcp, send this header (matches the seeded repo.remote_url):
#   X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git
# No Authorization header is needed under the dev bypass.
```

## Docs — "run in 2 commands"

Add a "Local Dev (Docker)" section to `README.md`:

```md
## Local Dev (Docker) — run in 2 commands

    cp .env.dev.example .env
    docker compose up --build

Compose starts postgres:16, runs migrations + the dev seed (one-shot), then the app.
When ready, GET http://localhost:3000/health returns 200.

Gate 1 (Cognito) is STUBBED by DevAuthenticator (AUTH_DEV_BYPASS=true); Gate 2, RBAC,
and audit run for real against the seeded DB. Every request must carry the seeded git
remote header; no Authorization header is needed locally.

### Sample POST /mcp — recall (JSON-RPC tools/call)

    curl -sS http://localhost:3000/mcp \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H 'X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git' \
      -d '{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": "recall", "arguments": { "query": "pnpm package manager" } }
          }'

### Sample POST /mcp — get_context

    curl -sS http://localhost:3000/mcp \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H 'X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git' \
      -d '{
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": "get_context", "arguments": {} }
          }'

The X-Git-Remote header is load-bearing: it resolves the tenant. A missing or
unregistered remote returns a generic PERMISSION_DENIED (no tenant enumeration).
```

## Tests

`tests/auth/devAuthenticator.test.ts`:
- `authenticate(undefined)` resolves to `DEV_PRINCIPAL` (subject `dev-local-user`,
  clientId `dev-local-client`, scopes `['lpms.memory/read']`).
- `authenticate('Bearer anything')` resolves to the identical fixed principal (arg ignored).
- Never throws — asserts it resolves for both a valid-looking and a garbage header.

```ts
import { describe, it, expect } from 'vitest';
import { DevAuthenticator, DEV_PRINCIPAL } from '../../src/auth/devAuthenticator.js';

describe('DevAuthenticator', () => {
  const auth = new DevAuthenticator();
  it('returns the fixed principal regardless of the header', async () => {
    expect(await auth.authenticate(undefined)).toEqual(DEV_PRINCIPAL);
    expect(await auth.authenticate('Bearer whatever')).toEqual(DEV_PRINCIPAL);
    expect(DEV_PRINCIPAL.subject).toBe('dev-local-user'); // must match seed idp_subject
  });
});
```

`tests/config/prodGuard.test.ts` — asserts the load-bearing fail-fast. `loadConfig()` calls
`process.exit(1)` on failure, so spy on `process.exit`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

async function loadFresh() {
  vi.resetModules();
  return (await import('../../src/config/index.js')).loadConfig;
}

describe('config prod guard', () => {
  it('fails fast when AUTH_DEV_BYPASS=true and NODE_ENV=production', async () => {
    process.env = { DATABASE_URL: 'postgres://x/y', AUTH_DEV_BYPASS: 'true', NODE_ENV: 'production' };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadConfig = await loadFresh();
    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('loads under the dev bypass with NO Cognito vars (dev, bypass on)', async () => {
    process.env = { DATABASE_URL: 'postgres://x/y', AUTH_DEV_BYPASS: 'true', NODE_ENV: 'development' };
    const loadConfig = await loadFresh();
    const cfg = loadConfig();
    expect(cfg.AUTH_DEV_BYPASS).toBe(true);
  });

  it('fails when the real path is missing Cognito vars (bypass off)', async () => {
    process.env = { DATABASE_URL: 'postgres://x/y', NODE_ENV: 'development' };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadConfig = await loadFresh();
    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/auth/devAuthenticator.ts` | Create | Dev-only `Authenticator` returning the fixed `DEV_PRINCIPAL` (subject matches the seed). |
| `src/db/seed.ts` | Create | Guarded dev seed runner; refuses under `NODE_ENV=production`; applies `seed.dev.sql`. |
| `migrations/seed.dev.sql` | Create | Idempotent sample data: 1 user/project/repo/membership + 4 memory rows (constraint, domain_rule, decision, gotcha). |
| `Dockerfile` | Create | Multi-stage (pnpm builder → non-root runtime running compiled `node dist/...`). |
| `.dockerignore` | Create | Excludes node_modules, dist, .git, tests, openspec, docs, .env*, etc. |
| `docker-compose.yml` | Create | db (postgres:16, healthcheck, volume) + one-shot migrate/seed + app (`AUTH_DEV_BYPASS=true`, `/health` healthcheck). |
| `.env.dev.example` | Create | DATABASE_URL, AUTH_DEV_BYPASS, NODE_ENV, PORT/HOST, and the exact X-Git-Remote value. |
| `tests/auth/devAuthenticator.test.ts` | Create | Asserts the fixed principal (subject `dev-local-user`) for any header. |
| `tests/config/prodGuard.test.ts` | Create | Asserts prod-guard fail-fast + dev-bypass load + real-path Cognito requirement. |
| `src/config/index.ts` | Modify | Add `AUTH_DEV_BYPASS`; make `COGNITO_*` optional; `.superRefine` prod guard + conditional Cognito requiredness. |
| `src/index.ts` | Modify | Composition-root branch: `DevAuthenticator` vs `CognitoAuthenticator`; loud WARN banner; move Cognito build into the real branch. |
| `src/db/migrate.ts` | Modify | Tighten file filter to numbered migrations `^\d{4}_.*\.sql$` so `seed.dev.sql` is NEVER applied by the prod migrate runner (security). |
| `package.json` | Modify | Add `"seed:dev": "tsx src/db/seed.ts"` script (no dependency changes). |
| `README.md` | Modify | Add "Local Dev (Docker)" run-in-2-commands section + sample `POST /mcp` calls. |
