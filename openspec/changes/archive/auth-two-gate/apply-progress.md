# Apply Progress — Auth Two-Gate (Cognito JWT + RBAC)

schema: apply-progress-v1
change: auth-two-gate
mode: automatic

## Wave 1 (parallel: Group A ∥ Group B)
- Group A (T101–T107): package.json (+aws-jwt-verify, +pg, +@types/pg, migrate script),
  config env (DATABASE_URL + 4 COGNITO_* vars), src/security/hash.ts, migrations/0001_auth_tenancy.sql
  (4 enums + 6 tables), src/db/{pool,migrate,authRepository}.ts (parameterized queries). Clean on own files.
- Group B (T121–T124): src/mcp/context.ts (Principal + Authenticator seam; Authorizer→ActorIdentity;
  Deps split into AuthServices + resolutionInput; Placeholder*/PLACEHOLDER_ACTOR removed);
  tools/index.ts (new call order + server-side query_hash); transport.ts (makeMcpPostHandler +
  X-Git-Remote/Branch extraction); http/app.ts (createApp(services)). 18 existing tests still green.

## Wave 2 (parallel: Group C ∥ Group D)
- Group C (T141–T145): src/auth/{authenticator,tenantResolver,authorizer,auditLogger}.ts + src/index.ts
  boot DI (composition root). Injectable CognitoVerifier interface (real aws-jwt-verify import isolated
  to index.ts). All denials → AppError(PERMISSION_DENIED) opaque; machine path fail-CLOSED; RDS roles
  preferred; server-side query_hash. ESLint clean.
- Group D (T161–T168): 7 new test files + 2 existing updated to pass stub AuthServices.
  **Vitest: 73 pass / 12 skipped (migration integration, no DATABASE_URL) / 0 fail.**

## Deviations / notes
- Config var names: `COGNITO_USER_POOL_ID` + `COGNITO_REGION` + `COGNITO_CLIENT_ID_ALLOWLIST` +
  `COGNITO_REQUIRED_SCOPE` (aws-jwt-verify derives issuer/JWKS from pool id) — per design, confirm vs infra.
- CognitoVerifier injected as a structural interface so authenticator is testable without the lib.

## BLOCKER (open) — runtime dependency install
`pg` and `aws-jwt-verify` are declared in package.json but NOT installed and NOT in package-lock.json.
The `guard-package-manager` hook blocks runtime `npm install`; `npm ci` fails (lockfile out of sync).
Runtime deps were NOT smuggled as devDependencies (policy). Consequence: `npm run build` (tsc) fails on
module resolution for pg/aws-jwt-verify. Tests already pass under vitest (type-only imports elided).

RESOLUTION (tooling standardized on pnpm-ONLY):
- Repo cleaned: removed bun.lock + package-lock.json + node_modules. pnpm pinned via
  package.json packageManager (pnpm@9.15.0) + engines + .npmrc engine-strict; guard rewritten
  to block npm/yarn/bun and non-frozen pnpm installs.
- pg ^8 and aws-jwt-verify ^4 are already in package.json dependencies.
- NEXT (human, one-time, out-of-band): run `pnpm install` in a trusted shell to generate
  pnpm-lock.yaml + node_modules. Then the orchestrator runs `pnpm install --frozen-lockfile`
  (allowed by the new guard) + build/test/lint → verify → archive.

## Verify remediation batch (1 worker) — after pnpm install resolved
Fixed F1 (runMigrations export + main-module guard + decoupled from Cognito config), F2 (bare ledger
version), F3 (migration needs only DATABASE_URL), M-01 (prod DB TLS), F4/F5 + L-02/L-03/L-04/L-05/L-06/L-08,
cleared 3 lint warnings. Re-verified: build ✓ · test 73 pass/12 skip · lint 0 err/0 warn.
Files: src/db/{migrate,pool}.ts, src/config/index.ts, src/index.ts, src/auth/authenticator.ts,
src/security/hash.ts, src/http/app.ts, src/mcp/tools/index.ts, tests/db/migrate.integration.test.ts.

## Status: COMPLETE — verify PASS, archived. Deferred items (rate-limit, helmet, archived filter,
## machine_credential unique, service-agent auth) tracked in openspec/backlog.md.
