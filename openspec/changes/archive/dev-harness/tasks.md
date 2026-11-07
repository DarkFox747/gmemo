# Tasks — Dev Harness

schema: tasks-v1
change: dev-harness

3 file-disjoint groups run in parallel. All signatures/DDL/Docker specifics fixed in design.md —
workers MUST follow it verbatim. Security load-bearing: the prod guard (config + index + seed + migrate filter).

## Group A — core code (one worker; config↔index coupling)
- [x] T301 `src/config/index.ts` — add `AUTH_DEV_BYPASS` (enum('true','false')→boolean, default false; NOT z.coerce.boolean); make `COGNITO_*` field-level `.optional()`; `.superRefine`: require COGNITO_* on the real path AND FAIL when `AUTH_DEV_BYPASS && NODE_ENV==='production'`. (REQ-04,05,06,07)
- [x] T302 `src/auth/devAuthenticator.ts` — `DevAuthenticator implements Authenticator` returning fixed `DEV_PRINCIPAL { subject:'dev-local-user', clientId:'dev-local-client', scopes:['lpms.memory/read'] }`; loud dev-only comment. (REQ-01)
- [x] T303 `src/index.ts` — select DevAuthenticator vs CognitoAuthenticator on `config.AUTH_DEV_BYPASS && NODE_ENV!=='production'` (defense-in-depth 2nd check); move `CognitoJwtVerifier.create` into the real branch with a narrowing guard for now-optional COGNITO_*; WARN banner when bypass active; one AppServices field changes. (REQ-02,03,08)
- [x] T304 `src/db/migrate.ts` — tighten the migration file filter to `^\d{4}_.*\.sql$` so `seed.dev.sql` is NEVER applied by the prod migrate runner. (REQ-10)
- [x] T305 `src/db/seed.ts` — dev-only seed runner: refuse when `NODE_ENV==='production'`; apply `migrations/seed.dev.sql` via the pool; runnable entry (main-module guard). (REQ-10,11)
- [x] T306 `migrations/seed.dev.sql` — idempotent (`ON CONFLICT DO NOTHING`, fixed UUIDs): 1 project, 1 repo (remote_url `https://github.com/crombie-dev/lpms-cloud.git`), 1 app_user (idp_subject `dev-local-user`), 1 project_membership (viewer), 4 memory rows (constraint, domain_rule, decision, gotcha; provenance='manual_ui'; budgets respected; content_tsv omitted — generated). (REQ-09,11)
- [x] T307 `package.json` — add `seed:dev` script (`node dist/db/seed.js`, or `tsx src/db/seed.ts` for local). (REQ-10)

## Group B — Docker / infra / docs (one worker; independent files)
- [x] T320 `Dockerfile` — multi-stage: builder (node:22-alpine, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm prune --prod`) → runtime (copy dist + pruned node_modules + migrations/, non-root `node` user, `CMD ["node","dist/index.js"]`). No secrets; no `.env` copied. (REQ-12,14)
- [x] T321 `.dockerignore` — node_modules, dist, .git, tests, docs, openspec, .env*, coverage. (REQ-12)
- [x] T322 `docker-compose.yml` — `db` (postgres:16, POSTGRES_* env, healthcheck, named volume); a one-shot migrate+seed step (`node dist/db/migrate.js && node dist/db/seed.js`); `app` (build ., depends_on db healthy, env DATABASE_URL [local, no ssl], AUTH_DEV_BYPASS=true, NODE_ENV=development, PORT), port map, `/health` healthcheck. (REQ-13)
- [x] T323 `.env.dev.example` — DATABASE_URL (local pg), AUTH_DEV_BYPASS=true, NODE_ENV=development, PORT, and the exact `X-Git-Remote` value = seeded repo remote_url. (REQ-15)
- [x] T324 `README.md` — "Levantar en 2 comandos" section: `docker compose up` → `GET /health` + a sample `POST /mcp` recall/get_context call incl. the `X-Git-Remote` header. (REQ-16)

## Group C — tests (one worker; follows design.md shapes)
- [x] T340 `tests/auth/devAuthenticator.test.ts` — asserts DevAuthenticator returns the fixed principal. (REQ-17)
- [x] T341 `tests/config/prodGuard.test.ts` — `AUTH_DEV_BYPASS=true` + `NODE_ENV=production` → loadConfig throws; COGNITO_* optional when bypass active; real path still requires them. (REQ-18)

## Finalization (verify phase)
- [x] T360 `pnpm build && pnpm test -- --run && pnpm lint` — all green (build clean, 163 pass / 26 skip,
      lint 0 err/warn). Verify PASS after remediation of the Dockerfile CRITICAL + .gitignore HIGH + M01.
