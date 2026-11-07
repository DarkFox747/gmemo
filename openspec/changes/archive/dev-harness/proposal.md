# Proposal — Dev Harness (locally runnable & testable MCP server)

schema: proposal-v1
change: dev-harness
status: draft
author: sdd-orchestrator
depends_on: scaffold-runtime-mcp-facade, auth-two-gate, data-model (all archived)

## Problem / Motivation

The code is complete for the read path, but after auth-two-gate the server requires a live
Postgres + Cognito to boot, so it can no longer be run standalone like the scaffold. This
change makes the MCP server **locally runnable and testable end-to-end** with `docker compose
up`, without a real Cognito user pool, while keeping the real DB/RBAC/audit path exercised.

## Chosen Approach

Only the **Cognito dependency (Gate 1)** is stubbed for local dev; **everything else stays
real** against a local Postgres. `docker compose` runs the app + `postgres:16`, applies the
migrations, and seeds sample data. A dev-only authenticator returns a fixed `Principal` whose
`subject` matches a seeded `app_user`, so the REAL `RdsTenantResolver` + `RdsAuthorizer` +
`RdsAuditLogger` run against the seeded DB (Gate 2, RBAC, audit all genuinely exercised).

### Decisions I am making (flag me to change any)

- **D1 — Bypass ONLY Gate 1, keep Gate 2/RBAC/audit real.** A `DevAuthenticator` (implements the
  existing `Authenticator` seam) returns a fixed `Principal { subject: <seeded idp_subject>, ... }`
  without contacting Cognito. `RdsTenantResolver`/`RdsAuthorizer`/`RdsAuditLogger` run unchanged
  against local Postgres. This exercises far more real code than a full bypass.
- **D2 — Hard production guard.** The dev bypass is selected ONLY when `NODE_ENV !== 'production'`
  AND an explicit `AUTH_DEV_BYPASS=true`. If `AUTH_DEV_BYPASS=true` AND `NODE_ENV==='production'`,
  the app **fails fast at boot** (refuses to start). Default (flag unset) = real Cognito authenticator.
- **D3 — Composition-root switch only.** The dev/real Authenticator choice lives solely in
  `src/index.ts` boot DI (guarded by config). No handler, seam interface, or business logic changes.
  Cognito env vars become OPTIONAL when the bypass is active (so the app boots without them locally).
- **D4 — Seed via SQL applied after migrations.** A `seed.dev.sql` inserts one project, one repo
  (`remote_url` for `X-Git-Remote`), one `app_user` (idp_subject = the dev principal), one
  `project_membership` (viewer), and a handful of `memory` rows (a constraint, a domain_rule, a
  decision, a gotcha) so `recall`/`get_context`/`get_memory` return real data. Dev-only, never in prod.
- **D5 — Docker: multi-stage, pnpm, non-root.** Build stage runs `pnpm install --frozen-lockfile` +
  `pnpm build`; runtime stage runs `node dist/index.js` as a non-root user. Compose wires app + db +
  a one-shot migrate/seed step; healthcheck on `/health`.

## Scope

### IN scope
- `Dockerfile` (multi-stage, pnpm via corepack, non-root runtime) + `.dockerignore`.
- `docker-compose.yml`: `db` (`postgres:16`, healthcheck, volume), `app` (depends_on db healthy,
  runs migrate then starts), env wiring; a documented `AUTH_DEV_BYPASS` dev profile.
- `src/auth/devAuthenticator.ts`: `DevAuthenticator implements Authenticator` returning a fixed Principal.
- `src/config/index.ts`: add `AUTH_DEV_BYPASS` (boolean, default false); make Cognito vars optional
  when bypass is active; **fail-fast if bypass && NODE_ENV==='production'**.
- `src/index.ts`: select `DevAuthenticator` vs `CognitoAuthenticator` at boot based on config.
- `migrations/seed.dev.sql` + a dev-only seed runner (or a compose step) — NOT wired into the prod migrate path.
- `.env.example` / `.env.dev.example`: document `DATABASE_URL`, `AUTH_DEV_BYPASS`, `X-Git-Remote` value.
- Docs: a "run in 2 commands" section (`docker compose up` → `/health` + `POST /mcp`), incl. a sample
  MCP `recall`/`get_context` call and the `X-Git-Remote` header for the seeded repo.
- Tests: a unit test for `DevAuthenticator` + a config test asserting the prod-guard fail-fast.

### OUT of scope (deferred)
- Production Docker/ECR/Fargate image hardening & CI publish (separate infra change).
- Write tools / staging / promotion (write-path change).
- Real Cognito provisioning, helmet, rate-limit (backlog).
- pgvector.

## Affected Areas

| Area | What changes | New/Modified |
|------|--------------|--------------|
| Docker | Dockerfile + .dockerignore + docker-compose.yml | New |
| Dev auth bypass | DevAuthenticator + config flag + prod guard + index.ts switch | New/Modified |
| Seed data | seed.dev.sql + dev seed step | New |
| Docs / env | run guide + .env.dev.example | New/Modified |
| Tests | DevAuthenticator + prod-guard config test | New |

_5 affected areas → NOT simple; design phase runs._

## Constraints (security-critical)
- The dev bypass MUST be impossible in production: `AUTH_DEV_BYPASS=true` + `NODE_ENV=production`
  → hard boot failure. Default path = real Cognito. Seed data + bypass never ship to prod.
- Container runs as non-root; no secrets baked into the image; `.env` not copied into the image.
- Gate 2 (RDS user+membership), RBAC, and audit remain REAL and unchanged — only the Cognito call is stubbed.
- pnpm-only inside the image (`corepack` + `pnpm install --frozen-lockfile`); no npm/bun.
- YAGNI: no new runtime deps (Docker/compose/SQL only).

## Rejected Alternatives
- **Full auth bypass** (stub Gate 2/RBAC too) — would leave RBAC/audit untested locally and risk a
  fake-data code path near real enforcement. Rejected (D1): stub only Cognito.
- **Locally-signed test JWT + real verifier** — needs a JWKS/key setup and pins us to Cognito token
  internals for local dev; heavier than a DevAuthenticator behind a hard prod guard. Rejected.
- **Seeding via app write tools** — the write path does not exist yet; SQL seed is the pragmatic choice.

## Risks
- A mis-set `AUTH_DEV_BYPASS` in a real environment — mitigated by the hard `NODE_ENV==='production'`
  fail-fast guard (D2) and default-off.
- Compose migrate/seed ordering — mitigated by `depends_on: db healthy` + a one-shot migrate step before app start.

## Next Phases
specs ∥ design → tasks → apply → verify → archive.
