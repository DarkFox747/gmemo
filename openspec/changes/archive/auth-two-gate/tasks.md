# Tasks — Auth Two-Gate (Cognito JWT + RBAC, read path)

schema: tasks-v1
change: auth-two-gate

Coupled change: `src/mcp/context.ts` interface redesign ripples to impls + wiring.
Executed in TWO WAVES to avoid interface drift. Within a wave, groups touch disjoint
files (parallel-safe). All signatures/paths are fixed in design.md — workers MUST follow
design.md verbatim for interface shapes.

## WAVE 1 (parallel: Group A ∥ Group B)

### Group A — DB layer + foundation
- [x] T101 `package.json` — add deps `aws-jwt-verify`, `pg`; dev `@types/pg`; add `migrate` script. (REQ-01,05)
- [x] T102 `src/config/index.ts` — add `DATABASE_URL`, `COGNITO_USER_POOL_ID`, `COGNITO_REGION`, `COGNITO_CLIENT_ID_ALLOWLIST`, `COGNITO_REQUIRED_SCOPE`; fail-fast validation. (REQ-02,06)
- [x] T103 `src/security/hash.ts` — `sha256Hex(input)` for server-side `query_hash`. (REQ-17)
- [x] T104 `migrations/0001_auth_tenancy.sql` — enums + 6 tables + indexes/constraints, faithful to schema v2; NO memory/staging tables. (REQ-03)
- [x] T105 `src/db/pool.ts` — pg `Pool` singleton factory from `DATABASE_URL`. (REQ-01)
- [x] T106 `src/db/migrate.ts` — forward-only runner + `schema_migrations` ledger; idempotent, no drops. (REQ-04)
- [x] T107 `src/db/authRepository.ts` — `AuthRepository` interface + pg impl (findAppUserBySubject, resolveRepoByRemote→project, findMembership, insertAccessLog). (REQ-09,11,12,16)

### Group B — seam interfaces + request wiring (NO boot DI)
- [x] T121 `src/mcp/context.ts` — `Principal` + `Authenticator` seam; `Authorizer.authorize(principal, tenant, tool) → ActorIdentity`; split `Deps` into boot `AuthServices` + per-request `resolutionInput`; REMOVE Placeholder* + PLACEHOLDER_ACTOR. (REQ-14,20,21)
- [x] T122 `src/mcp/tools/index.ts` — new call order authenticate → resolveTenant → authorize(→ActorIdentity) → auditRead → handler; server-side `query_hash`; remove PLACEHOLDER_ACTOR. (REQ-16,17,22)
- [x] T123 `src/mcp/transport.ts` — `makeMcpPostHandler(services)`; extract `X-Git-Remote`/`X-Git-Branch`; no per-request `new`. (REQ-09,20)
- [x] T124 `src/http/app.ts` — `createApp(services)` threads AuthServices to the MCP handler. (REQ-20)

## WAVE 2 (parallel: Group C ∥ Group D) — after Wave 1

### Group C — auth implementations + boot DI
- [x] T141 `src/auth/authenticator.ts` — Cognito JWKS Gate 1 (tokenUse=access, clientId allowlist, scope; aud NOT checked); injectable verifier; cache/rotation; opaque throw. (REQ-05,06,07,08)
- [x] T142 `src/auth/tenantResolver.ts` — `X-Git-Remote` → repo → project; opaque deny on missing/not-found. (REQ-09,10)
- [x] T143 `src/auth/authorizer.ts` — Gate 2 (app_user enabled) + read RBAC (membership viewer+) → `ActorIdentity`; RDS roles preferred; global role still needs membership; machine path fail-CLOSED. (REQ-11,12,13,14,15,18)
- [x] T144 `src/auth/auditLogger.ts` — insert `access_log` (actor_kind=user, action=read, project_id, query_hash). (REQ-16,17)
- [x] T145 `src/index.ts` — boot DI: Pool + verifier + AuthRepository + seam singletons, `createApp(services)`, setLogLevel, listen. (REQ-01,20)

### Group D — tests
- [x] T161 `tests/auth/fakes.ts` — in-memory `AuthRepository` fake + stub `AuthServices`. (REQ-24)
- [x] T162 `tests/auth/authenticator.test.ts` — valid / invalid / expired / wrong-client / missing-scope. (REQ-23)
- [x] T163 `tests/auth/tenantResolver.test.ts` — found / not-found / missing header. (REQ-23)
- [x] T164 `tests/auth/authorizer.test.ts` — absent / disabled / no-membership deny; happy → ActorIdentity; machine denied; global role still needs membership. (REQ-23)
- [x] T165 `tests/auth/auditLogger.test.ts` — access_log written with server-side query_hash; raw query never stored. (REQ-16,17)
- [x] T166 `tests/auth/opacity.test.ts` — every denial → byte-identical "Access denied."; no enumeration. (REQ-22)
- [x] T167 `tests/db/migrate.integration.test.ts` — SKIP when DATABASE_URL unset; else apply + assert tables/enums. (REQ-24)
- [x] T168 MODIFY existing tests to pass a stub `AuthServices`; keep green. (REQ-24)

## Finalization (verify phase)
- [x] T180 `pnpm build && pnpm test -- --run && pnpm lint` — all green (build clean, 73 pass / 12 skip,
      lint 0 err / 0 warn). Deps installed via pnpm; verify PASS after remediation of F1/F2/F3/M-01/LOWs.
