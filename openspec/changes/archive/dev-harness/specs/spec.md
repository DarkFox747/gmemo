# Spec — Dev Harness (locally runnable & testable MCP server)

schema: spec-v1
change: dev-harness
status: draft

## Overview

Make the LPMS MCP server runnable end-to-end locally via `docker compose up`, without a real
Cognito user pool, while keeping the real Postgres/RBAC/audit path exercised. Only Gate 1
(Cognito) is stubbed behind a hard, production-impossible dev flag; sample data is seeded so
the read tools return real results.

## Requirements

### Dev auth bypass (Gate 1 only)
- **REQ-01** A `DevAuthenticator` MUST implement the existing `Authenticator` seam and return a fixed
  `Principal` whose `subject` equals the seeded `app_user.idp_subject`, WITHOUT contacting Cognito.
- **REQ-02** `RdsTenantResolver`, `RdsAuthorizer`, and `RdsAuditLogger` MUST remain unchanged and run
  for real against the local Postgres (Gate 2, RBAC, and audit are genuinely exercised).
- **REQ-03** The Dev vs Cognito authenticator selection MUST live ONLY in `src/index.ts` boot DI,
  driven by config. No handler, seam interface, or business-logic change.

### Production guard (load-bearing)
- **REQ-04** `AUTH_DEV_BYPASS` (boolean, default `false`) MUST be added to the validated config.
- **REQ-05** The dev bypass MUST engage ONLY when `NODE_ENV !== 'production'` AND `AUTH_DEV_BYPASS=true`.
- **REQ-06** If `AUTH_DEV_BYPASS=true` AND `NODE_ENV==='production'`, the app MUST fail fast at boot
  (refuse to start) with a clear error — never silently run bypassed in production.
- **REQ-07** When the bypass is active, COGNITO_* env vars MUST be optional (the app boots without them);
  when inactive (default), the real Cognito config remains required (fail-fast as today).
- **REQ-08** Boot MUST log loudly (WARN) when the dev bypass is active.

### Seed data (dev-only)
- **REQ-09** `migrations/seed.dev.sql` MUST insert, honoring 0001/0002 FKs, enums, and CHECK budgets:
  one `project`, one `repo` (with a known `remote_url`), one `app_user` (idp_subject = dev principal),
  one `project_membership` (viewer+), and several `memory` rows (≥ one each of constraint, domain_rule,
  decision, gotcha) so recall/get_context/get_memory return data.
- **REQ-10** The seed MUST be applied dev-only (compose step or a `NODE_ENV=production`-guarded script)
  and MUST NOT be part of the production migrate path.
- **REQ-11** The seed MUST be idempotent/re-runnable (e.g. ON CONFLICT DO NOTHING) so `docker compose up`
  can repeat safely.

### Containerization
- **REQ-12** A multi-stage `Dockerfile` MUST build with pnpm via corepack (`pnpm install --frozen-lockfile`
  + `pnpm build`) and run `node dist/index.js` as a **non-root** user. No secrets baked into the image;
  `.env*` MUST NOT be copied in. A `.dockerignore` MUST exclude node_modules, dist, .git, tests, docs, openspec, .env*.
- **REQ-13** `docker-compose.yml` MUST define `db` (`postgres:16`, healthcheck, named volume) and the app,
  apply migrations + seed before the app serves, wire `DATABASE_URL`/`AUTH_DEV_BYPASS=true`/`NODE_ENV=development`,
  map the app port, and healthcheck `/health`. The app MUST wait for db healthy.
- **REQ-14** Only pnpm may be used inside the image (no npm/bun).

### Docs & env
- **REQ-15** `.env.dev.example` MUST document `DATABASE_URL`, `AUTH_DEV_BYPASS`, `NODE_ENV`, `PORT`, and the
  exact `X-Git-Remote` value matching the seeded repo.
- **REQ-16** A "run in 2 commands" doc section MUST show `docker compose up` → `GET /health` +
  a sample `POST /mcp` `recall`/`get_context` call including the required `X-Git-Remote` header.

### Testing
- **REQ-17** A unit test MUST assert `DevAuthenticator` returns the fixed principal.
- **REQ-18** A config test MUST assert the prod guard: `AUTH_DEV_BYPASS=true` + `NODE_ENV=production`
  fails at config load; and that COGNITO_* become optional when bypass is active.
- **REQ-19** `pnpm build && pnpm test -- --run && pnpm lint` MUST be green (0 lint err/warn); existing
  tests stay green; DB integration tests still skip without DATABASE_URL.

## Acceptance Criteria
- `docker compose up` boots Postgres, applies migrations + seed, starts the app; `GET /health` = 200.
- A `POST /mcp` `recall`/`get_context` with the seeded `X-Git-Remote` returns real seeded memory
  (Gate 2 + RBAC + audit all ran against local Postgres; only Cognito was stubbed).
- Setting `NODE_ENV=production` with `AUTH_DEV_BYPASS=true` makes the app refuse to start.
- No new runtime dependency; container runs as non-root; pnpm-only inside; seed/bypass absent from prod path.
- Full pnpm build/test/lint green.

## Out of Scope (traceability)
Production Docker/ECR/Fargate hardening + CI publish · write tools / staging / promotion · real Cognito
provisioning · helmet / rate-limit (backlog) · pgvector.
