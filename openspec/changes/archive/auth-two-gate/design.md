# Design: Auth Two-Gate (Cognito JWT + RDS RBAC, read path)

schema: design-v1
change: auth-two-gate
depends_on: scaffold-runtime-mcp-facade (archived)
blocks: data-model (change B)

## Technical Approach

Replace the three fail-open placeholder seams (`PlaceholderTenantResolver`,
`PlaceholderAuthorizer`, `PlaceholderAuditLogger`) with the real two-gate model for the
**interactive human read path**, and land the auth/tenancy RDS tables plus a minimal DB
layer that change B will reuse.

The scaffold already threads a `Deps` bag through `transport → server → tools/index`, calls
the seams in a fixed order inside each tool wrapper, and funnels every throw through
`toToolErrorResult()` for opacity. This change keeps that structure and plugs real logic into
it. The two structural moves:

1. **Add a Gate-1 `Authenticator` seam** in front of tenant resolution, and **change
   `Authorizer.authorize` to RETURN the resolved `ActorIdentity`** (instead of `void`) so the
   actor gap is closed at the exact point roles become known (RDS `project_membership`), not
   from token claims.
2. **Move dependency construction to boot.** The JWKS verifier and the pg `Pool`-backed
   repository/seam implementations become process-level singletons injected through
   `createApp → makeMcpPostHandler`. The per-request handler builds only the small
   `resolutionInput` (headers) and spreads it onto the singleton services.

The new wrapper call order becomes:

    authenticate (Gate 1) → resolveTenant → authorize (Gate 2 + RBAC → ActorIdentity) → audit → handler

Handler signatures `(input, ctx, deps)` are **unchanged** — auth plugs into seams only.

## Architecture Decisions

### Decision: DB layer = pg Pool singleton + a thin AuthRepository + a hand-rolled forward-only migration runner

**Choice**:
- A single `pg.Pool` constructed once at boot in `src/db/pool.ts` (`createPool(connectionString)`),
  never per-request. The pool is injected into a `PgAuthRepository` (`src/db/authRepository.ts`)
  that exposes exactly the four queries the enforcement needs:
  `findRepoByRemoteUrl`, `findEnabledUserBySubject`, `findMembershipRole`, `insertAccessLog`.
  The three RDS-backed seam implementations depend on the `AuthRepository` interface, not on
  `Pool` directly.
- Migrations are forward-only `.sql` files in a repo-root `migrations/` directory
  (`0001_auth_tenancy.sql`). A tiny runner `src/db/migrate.ts` (pg only, no framework) creates
  a `schema_migrations(version text primary key, applied_at timestamptz)` ledger, sorts the
  `.sql` files by filename, and applies each unapplied file inside its own transaction,
  recording the version. Exposed as `npm run migrate`.

**Alternatives considered**:
- **`node-pg-migrate` / `knex` / Prisma** — a full migration/ORM dependency. Rejected: YAGNI.
  This change installs one migration; a heavy tool is unjustified surface and clashes with the
  raw-SQL schema-v2 source of truth.
- **Seams query the `Pool` directly (no repository interface)** — fewer files, but forces every
  auth-logic test to stand up a real Postgres. Rejected: it couples the security-critical
  branching (disabled check, membership check, opacity mapping) to live I/O.
- **`testcontainers` for all tests** — realistic but adds a Docker/dev dependency and slow,
  environment-sensitive tests for what are, in this slice, four trivial lookups.

**Rationale**: The `AuthRepository` interface is a *single, purpose-built* seam (not a generic
repository framework) whose only reason to exist is to isolate SQL so the security logic is
unit-testable with an in-memory fake — the task sanctions exactly this trade. The pool-singleton
matches the scaffold's "stateless compute, process-level caches" note and avoids reconnecting
per request. The runner is ~40 lines and keeps schema v2 as the literal source of truth.

### Decision: Add an `Authenticator` seam and make `Authorizer.authorize` return `ActorIdentity`

**Choice** — new/changed interfaces in `src/mcp/context.ts`:

```ts
// NEW — Gate 1 output (token-only principal; no RDS)
export interface Principal {
  subject: string;    // JWT `sub`
  clientId: string;   // Cognito `client_id`
  scopes: string[];   // Cognito `scope`, space-split
}

// NEW — Gate 1 seam. Throws AppError(PERMISSION_DENIED) on any invalid/absent token.
export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

// CHANGED — Gate 2 + RBAC. Was: authorize(ctx, tool): Promise<void>.
// Now takes the Gate-1 principal + resolved tenant and RETURNS the actor it derived
// from RDS. Throws AppError(PERMISSION_DENIED) if user absent/disabled or no membership.
export interface Authorizer {
  authorize(principal: Principal, tenant: TenantContext, tool: ToolName): Promise<ActorIdentity>;
}

// UNCHANGED shape, real impl now writes access_log.
export interface AuditLogger {
  recordRead(ctx: RequestContext, tool: ToolName, queryHash?: string): Promise<void>;
}
```

The wrapper builds `RequestContext` in stages: `authenticate` → `resolve` →
`actor = authorize(principal, tenant, tool)` → `ctx = { tenant, actor }` → `audit(ctx, …)` →
`handler(input, ctx, deps)`.

**Alternatives considered**:
- **Consolidate all of auth into one seam** (exploration Option B). Rejected in the proposal
  (breaks SRP; harder to test each gate in isolation).
- **Keep `authorize(): void` and produce the actor in a separate `resolveActor` step.**
  Rejected: roles come from the same `project_membership` lookup that authorizes the read —
  splitting them means two RDS round-trips and two places that can disagree.
- **Source roles from the token's `global_role` claim.** Rejected: prefer RDS `global_role`
  over any (possibly stale) token claim; the access decision must be RDS-authoritative.

**Rationale**: This is the "cleanest fit" the exploration identified. `authorize` already owns
the RDS membership lookup, so returning the `ActorIdentity` it just computed closes the actor
gap with zero extra queries and keeps the token (Gate 1) and RDS (Gate 2/RBAC) concerns on
separate seams. Handler signatures never see any of this.

### Decision: Singleton dependency injection through `createApp → makeMcpPostHandler`

**Choice**: Split the `Deps` bag into boot-time services vs per-request inputs:

```ts
export interface AuthServices {          // built ONCE at boot, injected
  authenticator: Authenticator;
  tenantResolver: TenantResolver;
  authorizer: Authorizer;
  auditLogger: AuditLogger;
}
export interface Deps extends HandlerDeps, AuthServices {
  resolutionInput: TenantResolutionInput; // built PER request (headers)
}
```

- `src/index.ts` (boot): `loadConfig()` → `createPool(DATABASE_URL)` →
  `CognitoJwtVerifier.create(...)` (best-effort `hydrate()`) → construct `PgAuthRepository`
  and the three RDS seams + the `CognitoAuthenticator` → assemble `AuthServices` →
  `createApp(services)`.
- `src/http/app.ts`: `createApp(services)` wires `app.post('/mcp', makeMcpPostHandler(services))`.
- `src/mcp/transport.ts`: `makeMcpPostHandler(services)` returns the Express handler, which
  per-request extracts headers into `resolutionInput`, spreads `{ ...services, resolutionInput }`
  into `Deps`, and hands it to `createMcpServer(deps)` exactly as today. No `new` in the hot path.

**Alternatives considered**:
- **Keep per-request `new` (current scaffold).** Rejected: re-creates the JWKS cache and a DB
  client on every call — refetch/reconnect per request, defeating both caches.
- **Module-level global singletons imported directly by the seams.** Rejected: hidden coupling,
  and it breaks the in-memory-fake test strategy (can't substitute services).

**Rationale**: Explicit constructor injection keeps the scaffold's testability (tests pass a
fake `AuthServices`) while making the expensive resources process-level, matching the stateless-
Fargate topology.

### Decision: Gate 1 via `aws-jwt-verify` `CognitoJwtVerifier`

**Choice** (`src/auth/authenticator.ts`):

```ts
const verifier = CognitoJwtVerifier.create({
  userPoolId: config.COGNITO_USER_POOL_ID,   // issuer + JWKS URI are DERIVED from this
  tokenUse: 'access',                          // rejects id/refresh tokens
  clientId: config.COGNITO_CLIENT_ID_ALLOWLIST, // string[] allowlist
  scope: config.COGNITO_REQUIRED_SCOPE,        // required scope on the token
});
```

`authenticate()` strips the `Bearer ` prefix, calls `verifier.verify(token)`, and on success
returns `{ subject: payload.sub, clientId: payload.client_id, scopes: String(payload.scope).split(' ') }`.
Any thrown verification error (bad signature, wrong `iss`, `token_use !== access`, expired,
`client_id` not in allowlist, missing scope) and any missing/malformed header are caught and
re-thrown as `AppError(PERMISSION_DENIED)`.

- **`aud` is intentionally NOT validated** — Cognito access tokens carry `client_id` + `scope`
  and no `aud`; `clientId` is the audience-equivalent check.
- **JWKS caching / rotation**: `aws-jwt-verify` caches JWKS keys in-process and auto-refreshes
  on an unknown `kid` (rate-limited), which handles Cognito key rotation with no extra code.
  Boot calls `verifier.hydrate()` best-effort (log-and-continue on network failure; the verifier
  lazy-fetches on first verify anyway) — we do NOT make boot a hard dependency on Cognito
  reachability for a resource server.

**Alternatives considered**: Hand-rolled `jose` verification — rejected (D7): more code and easy
to mis-model the Cognito access-token claim set (validating `aud` instead of `client_id`).

**Rationale**: AWS-maintained, Cognito-aware, verifies the exact claim set, and manages the
JWKS cache + rotation for us. One dependency, no bespoke crypto.

### Decision: Single generic denial for the entire auth/tenant/RBAC chain (no enumeration)

**Choice**: Map **all** of the following to `AppError(PERMISSION_DENIED)` → `"Access denied."`:
Gate-1 failure, tenant-not-found (unknown/absent `X-Git-Remote`), user absent, user disabled,
and no `project_membership` row. They are byte-for-byte indistinguishable to the caller.

**Alternatives considered**: Reuse the scaffold's `CONTEXT_UNAVAILABLE` ("Memory is not
available in this context.") for tenant-not-found. Rejected: a valid @<COMPANY_DOMAIN> token holder
could then diff "not available" (remote unregistered) vs "Access denied" (registered but no
membership) and enumerate which repos are onboarded — a project-existence oracle.

**Rationale**: Collapsing tenant-not-found into `PERMISSION_DENIED` removes that oracle and
satisfies the "no tenant/resource enumeration" convention. `CONTEXT_UNAVAILABLE` stays in the
enum for a genuine future "no data yet for a project you DO have access to" case, but is **not**
used to distinguish tenant existence in the auth path. Trade-off: a developer pointing at an
un-onboarded repo sees "Access denied" rather than onboarding guidance — acceptable because
onboarding is an out-of-band ticket flow, not an API affordance.

### Decision: Machine/service-agent path is fail-CLOSED now; constant-time compare is a deferred note

**Choice**: The `machine_credential` table is created, but **no code path consults it**. Gate 1
only accepts valid Cognito access tokens; a raw service-agent bearer secret is not a valid
Cognito token, so it fails Gate 1 → `PERMISSION_DENIED`. There is deliberately no
`MachineAuthenticator` wired (its absence *is* the fail-closed deny). When the service-agent
path is implemented in a follow-up, the `token_hash` comparison MUST use a constant-time compare
(`crypto.timingSafeEqual` over fixed-length digests) to avoid a timing oracle. We do NOT add
that helper now (YAGNI — no live caller).

**Alternatives considered**: A `DenyMachineAuthenticator` stub. Rejected: adds unused code for a
deny that already happens for free at Gate 1.

**Rationale**: Fail-closed is safe; a half-wired second Gate-2 path is not. Deferring keeps scope
tight (D2).

### Decision: `query_hash` computed server-side; `ActorIdentity.actorId` = raw JWT `sub`

**Choice**: `src/security/hash.ts` exposes `sha256Hex(input: string): string`. The `recall`
wrapper computes `query_hash = sha256Hex(normalize(query))` and passes it to `recordRead`; the
raw query text is never logged. `get_memory` hashes its `handle`; `get_context` has no query
(hash omitted). `access_log.actor_identity = ctx.actor.actorId = principal.subject` (raw `sub`,
D5) and `actor_kind = 'user'`.

**Rationale**: Server-side hashing guarantees the raw query never reaches `access_log`
(client-supplied hashes are untrusted and could break audit integrity). Raw `sub` is a stable,
non-PII identifier already unique in `app_user.idp_subject`.

## Data Flow

    POST /mcp
      │  headers: Authorization, X-Git-Remote, X-Git-Branch
      ▼
    makeMcpPostHandler(services)              ── singletons injected at boot
      │  build resolutionInput = { authorization, gitRemote, branch }
      │  deps = { ...services, resolutionInput }
      ▼
    tool wrapper (recall | get_memory | get_context)
      │
      ├─(1) authenticate(authorization) ─────────────► CognitoJwtVerifier (JWKS cache)
      │        └─ Principal{ subject, clientId, scopes }        │ throws → PERMISSION_DENIED
      │
      ├─(2) resolveTenant(resolutionInput) ──────────► AuthRepository.findRepoByRemoteUrl
      │        └─ TenantContext{ projectId, repoId, branch }    │ null → PERMISSION_DENIED
      │
      ├─(3) authorize(principal, tenant, tool) ──────► findEnabledUserBySubject
      │        │                                                │ null → PERMISSION_DENIED
      │        └─ findMembershipRole(projectId, userId)         │ null → PERMISSION_DENIED
      │           returns ActorIdentity{ actorId, roles }
      │
      │     ctx = { tenant, actor }
      │
      ├─(4) audit: recordRead(ctx, tool, sha256Hex(query)) ──► access_log INSERT
      │
      └─(5) handler(input, ctx, deps) ──► toToolResult
                                   │
                            any throw ──► toToolErrorResult (opaque)

## Auth Flow (step-by-step, `recall`)

1. **POST /mcp** arrives. `makeMcpPostHandler` reads `Authorization`, `X-Git-Remote`,
   `X-Git-Branch` headers into `resolutionInput` (array-header normalized as today).
2. **Gate 1** — `authenticate(authorization)`: verify Cognito access token (sig via JWKS,
   `iss`, `token_use=access`, `exp`, `client_id ∈ allowlist`, required `scope`; not `aud`).
   Fail/absent → `PERMISSION_DENIED` (nothing logged; no tenant known yet).
3. **Tenant resolution** — `resolve(resolutionInput)`: `findRepoByRemoteUrl(gitRemote)` →
   `{ repoId, projectId, defaultBranch }`. Missing header or unknown remote →
   `PERMISSION_DENIED`. `branch` = supplied `X-Git-Branch` or repo `default_branch`.
4. **Gate 2** — `findEnabledUserBySubject(principal.subject)` (`idp_subject = sub AND
   disabled_at IS NULL`). Null (absent OR disabled — indistinguishable) → `PERMISSION_DENIED`.
5. **RBAC** — `findMembershipRole(projectId, userId)`. Null → `PERMISSION_DENIED` (D4: global
   roles still require a membership row for reads). Returns `ActorIdentity{ actorId: sub,
   roles: [globalRole?, projectRole] }`.
6. **Audit** — `recordRead(ctx, 'recall', sha256Hex(query))`: INSERT `access_log`
   (`actor_identity = sub`, `actor_kind = 'user'`, `action = 'read'`, `project_id`, `query_hash`,
   `detail = { tool, repoId }`). This is the FIRST successful side effect — only fully
   authorized reads are logged.
7. **Handler** runs (`recallHandler(input, ctx, deps)`), result wrapped by `toToolResult`.
   Any throw anywhere in 2–7 → `toToolErrorResult` → opaque text.

`get_memory` / `get_context` follow the same 1–7 with their own inputs; `get_context` logs with
no `query_hash`.

## DB Schema Slice (migration `0001_auth_tenancy.sql`)

Faithful subset of `docs/artefactos/lpms_schema_v2.sql` — the 6 auth/tenancy tables, the 4 enums
they use, and their indexes. `access_log.memory_id` / `session_id` are plain columns (no FK) in
v2, so this slice is self-contained (no memory/staging tables required).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ENUMS (only those referenced by the tenancy/audit tables) -------------------
CREATE TYPE global_role   AS ENUM ('platform_owner','platform_admin');
CREATE TYPE project_role  AS ENUM ('project_admin','contributor','viewer','service_agent');
CREATE TYPE actor_kind    AS ENUM ('user','agent','ci','system');
CREATE TYPE access_action AS ENUM ('read','stage','promote','update','delete','admin');

-- TENANCY ---------------------------------------------------------------------
CREATE TABLE app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idp_subject  text NOT NULL UNIQUE,
    email        text NOT NULL UNIQUE,
    display_name text,
    global_role  global_role,
    created_at   timestamptz NOT NULL DEFAULT now(),
    disabled_at  timestamptz
);

CREATE TABLE project (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_by  uuid REFERENCES app_user(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE TABLE repo (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    remote_url       text NOT NULL UNIQUE,       -- natural key for tenant resolution
    provider         text,
    slug             text,
    default_branch   text NOT NULL DEFAULT 'main',
    last_indexed_sha text,
    last_graph_build_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_repo_project ON repo(project_id);

CREATE TABLE project_membership (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role       project_role NOT NULL,
    granted_by uuid REFERENCES app_user(id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);
CREATE INDEX ix_membership_user ON project_membership(user_id);

CREATE TABLE machine_credential (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    principal_name text NOT NULL,
    token_hash     text NOT NULL,                -- hash only; secret never stored in clear
    role           project_role NOT NULL DEFAULT 'service_agent',
    created_by     uuid REFERENCES app_user(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz
);
CREATE INDEX ix_machinecred_project ON machine_credential(project_id);

-- AUDIT -----------------------------------------------------------------------
CREATE TABLE access_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            timestamptz NOT NULL DEFAULT now(),
    actor_identity text NOT NULL,
    actor_kind    actor_kind NOT NULL,
    action        access_action NOT NULL,
    project_id    uuid REFERENCES project(id) ON DELETE SET NULL,
    memory_id     uuid,
    session_id    text,
    query_hash    text,                           -- server-side hash of the read query
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_audit_ts      ON access_log(ts);
CREATE INDEX ix_audit_project ON access_log(project_id, ts);
CREATE INDEX ix_audit_actor   ON access_log(actor_identity, ts);
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `migrations/0001_auth_tenancy.sql` | Create | The 4 enums + 6 tenancy/audit tables + indexes above (schema-v2 subset). |
| `src/db/pool.ts` | Create | `createPool(connectionString): Pool` singleton factory + `closePool()`. |
| `src/db/migrate.ts` | Create | Forward-only runner: `schema_migrations` ledger, apply unapplied `.sql` files in txns. Run via `npm run migrate`. |
| `src/db/authRepository.ts` | Create | `AuthRepository` interface + `PgAuthRepository` (findRepoByRemoteUrl / findEnabledUserBySubject / findMembershipRole / insertAccessLog). |
| `src/auth/authenticator.ts` | Create | `Principal` type + `Authenticator` seam + `CognitoAuthenticator` (aws-jwt-verify). Maps all failures to `PERMISSION_DENIED`. |
| `src/auth/tenantResolver.ts` | Create | `RdsTenantResolver` — `X-Git-Remote` → repo → project; null → `PERMISSION_DENIED`. |
| `src/auth/authorizer.ts` | Create | `RdsAuthorizer` — Gate 2 (enabled user) + read RBAC (membership) → returns `ActorIdentity`. |
| `src/auth/auditLogger.ts` | Create | `RdsAuditLogger` — INSERT `access_log` (actor_kind=user, action=read, server-side query_hash). |
| `src/security/hash.ts` | Create | `sha256Hex(input)` for server-side `query_hash`. (Constant-time compare deferred with machine path.) |
| `src/config/index.ts` | Modify | Add `DATABASE_URL`, `COGNITO_USER_POOL_ID`, `COGNITO_REGION`, `COGNITO_CLIENT_ID_ALLOWLIST` (csv→string[]), `COGNITO_REQUIRED_SCOPE` to the zod fail-fast schema. |
| `src/mcp/context.ts` | Modify | Add `Principal` + `Authenticator`; change `Authorizer.authorize` to `(principal, tenant, tool) → ActorIdentity`; split `Deps` into `AuthServices` (singletons) + per-request `resolutionInput`; delete the 3 placeholder classes. |
| `src/mcp/transport.ts` | Modify | Replace per-request `new` placeholders with `makeMcpPostHandler(services)` factory; extract `Authorization` + `X-Git-Remote` + `X-Git-Branch` headers into `resolutionInput`. |
| `src/mcp/tools/index.ts` | Modify | New call order: authenticate → resolve → authorize(→actor) → build ctx → audit(query_hash) → handler; remove `PLACEHOLDER_ACTOR`. |
| `src/http/app.ts` | Modify | `createApp(services: AuthServices)`; wire `app.post('/mcp', makeMcpPostHandler(services))`. |
| `src/index.ts` | Modify | Boot DI: build Pool + Cognito verifier (hydrate best-effort) + repo + seams → `AuthServices` → `createApp(services)`. |
| `package.json` | Modify | deps: `aws-jwt-verify`, `pg`; devDeps: `@types/pg`; script: `"migrate": "tsx src/db/migrate.ts"`. |
| `tests/http/app.test.ts` (or `tests/health.test.ts`) | Modify | Pass a stub `AuthServices` to `createApp` now that DI is required. |
| `tests/auth/fakes.ts` | Create | `InMemoryAuthRepository` + fake `Authenticator` for deterministic unit tests. |
| `tests/auth/authenticator.test.ts` | Create | Gate-1 cases (mock verifier): valid / invalid sig / expired / wrong client_id / missing scope / missing header. |
| `tests/auth/tenantResolver.test.ts` | Create | remote found / unknown remote / missing header → `PERMISSION_DENIED`. |
| `tests/auth/authorizer.test.ts` | Create | user absent / disabled / no membership → deny; happy path returns `ActorIdentity`. |
| `tests/auth/auditLogger.test.ts` | Create | asserts an `access_log` row (actor, kind=user, action=read, project_id, query_hash) is written on success. |
| `tests/auth/opacity.test.ts` | Create | every denial (Gate1, tenant, user, membership, machine) yields the identical opaque `"Access denied."`. |
| `tests/db/migrate.integration.test.ts` | Create | Opt-in (skips when `DATABASE_URL` unset): runs the migration on a real Postgres, asserts the 6 tables/enums exist and an `access_log` insert round-trips. |

## Test Strategy

**Substrate choice (YAGNI): in-memory fake of `AuthRepository` as the primary substrate, plus a
single opt-in real-Postgres integration test.** Justification: the security-critical branching
(Gate-2 disabled/absent check, RBAC membership check, and opacity of every denial) lives in the
seam implementations and is fully exercisable against `InMemoryAuthRepository` — fast,
deterministic, no Docker. The SQL itself is four trivial lookups + one insert; correctness of the
DDL and the insert round-trip is covered by `migrate.integration.test.ts`, which **skips when
`DATABASE_URL` is absent** so CI stays green without a container runtime. This avoids adding a
`testcontainers` dev dependency (which would be the only reason to pull in Docker) while still
validating the migration against a real engine when one is available.

Gate 1 (`CognitoAuthenticator`) is tested by injecting a fake/mocked verifier object so no live
Cognito or JWKS network is needed; we assert the mapping of each verifier outcome to
`Principal` or `PERMISSION_DENIED`.

Enumerated cases:

- **Gate 1** — valid token → `Principal`; invalid signature → deny; expired → deny; `client_id`
  not in allowlist → deny; missing required scope → deny; missing/malformed `Authorization` →
  deny; `token_use != access` → deny.
- **Tenant resolution** — known `X-Git-Remote` → `TenantContext`; unknown remote → deny; missing
  `X-Git-Remote` header → deny.
- **Gate 2** — `sub` maps to enabled user → proceeds; user absent → deny; user
  `disabled_at IS NOT NULL` → deny (absent and disabled indistinguishable).
- **RBAC** — membership row present → `ActorIdentity` returned with role(s); no membership → deny
  (including a `platform_owner` with no membership → deny, per D4).
- **Happy path + audit** — full chain succeeds; exactly one `access_log` row written with
  `actor_kind='user'`, `action='read'`, correct `project_id`, non-null server-computed
  `query_hash` for `recall` (and null for `get_context`); raw query text never present.
- **Opacity** — each of {Gate1 fail, tenant-not-found, user absent, user disabled, no membership,
  machine/service-agent bearer} returns the byte-identical `"Access denied."` tool result with
  `isError: true`, and writes NO `access_log` row (audit only on authorized reads).
- **Machine path** — a non-Cognito bearer secret → Gate 1 deny (fail-closed; no
  `machine_credential` lookup occurs).
- **Wiring/regression** — existing `registration.test.ts` still lists exactly the 3 tools; the
  `createApp(services)` stub keeps `/health` and the transport tests green.
