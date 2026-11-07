# Apply Progress — Dev Harness

schema: apply-progress-v1
change: dev-harness
mode: automatic

## 3 parallel workers (file-disjoint)
- Group A (T301–T307, core): config `AUTH_DEV_BYPASS` (safe enum→bool) + optional COGNITO_* +
  superRefine prod-guard; `DevAuthenticator` (fixed DEV_PRINCIPAL); `index.ts` config-driven
  authenticator switch (WARN banner + NODE_ENV defense-in-depth); `migrate.ts` numbered-only filter
  (`^\d{4}_.*\.sql$`); `seed.ts` (refuses under NODE_ENV=production); `seed.dev.sql` (idempotent seed);
  `seed:dev` script. Verified: build ✓ + lint ✓ (0/0).
- Group B (T320–T324, infra): `Dockerfile` (multi-stage, corepack pnpm, prune --prod, non-root),
  `.dockerignore`, `docker-compose.yml` (postgres:16 healthcheck + one-shot migrate+seed + app),
  `.env.dev.example`, README "Levantar en 2 comandos" (curl samples + X-Git-Remote). Docker not run here
  (no daemon); paths/service names cross-checked vs design.
- Group C (T340–T341, tests): DevAuthenticator test + prod-guard config test. Verified: 163 tests pass, lint clean.

## Prod-guard (4 independent barriers)
1. config superRefine fails when AUTH_DEV_BYPASS && NODE_ENV=production.
2. index.ts selects DevAuthenticator only when NODE_ENV !== 'production'.
3. seed.ts refuses to run under NODE_ENV=production.
4. migrate.ts numbered-only filter excludes seed.dev.sql from the prod migrate path.

## Notes
- DevAuthenticator stubs ONLY Gate 1 (Cognito); Gate 2 + RBAC + audit run real vs local Postgres.
- seed:dev script uses tsx locally; compose runs `node dist/db/seed.js`.
- Image defaults NODE_ENV=production; compose overrides to development + AUTH_DEV_BYPASS=true for local only.

## Verify remediation batch (1 worker)
Fixed F1 (Dockerfile CRITICAL — copy migrations from build context), F2/M02 (HIGH — .gitignore negates
.env.dev.example), M01 (seed.ts fail-closed: refuse unless NODE_ENV===development), F4 (shared compose
image tag), and created/confirmed .env.dev.example (tracked; X-Git-Remote matches seed). Re-verified:
build ✓ · 163 pass / 26 skip · lint 0/0; `git check-ignore .env.dev.example` → not ignored.
Accepted: L01 (seed.dev.sql in image, guarded). Deferred: L03 helmet (backlog).

## Status: COMPLETE — verify PASS, archived. Docker `up --build` to be run once by a human (no daemon here).
