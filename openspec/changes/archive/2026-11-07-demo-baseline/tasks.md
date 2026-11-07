# Tasks: demo-baseline (C0)

> spec ↔ design reconciled, no divergences. Specs: `repository-hygiene` (new), `dev-harness` (delta). Design: Decisions 1–8, Areas A–J.
> **Authoring rule**: never write a literal sensitive value in any task output, report or commit. Refer to values by placeholder or as "the patterns in `.sanitize-patterns`".
> Areas are disjoint: tasks in different areas within one phase can run in parallel.

## Phase 1: Hygiene foundation (P1)

- [x] 1.1 Update `.gitignore`: add `.claude/`, `.claude.json`, `.mcp.json`, `entrevistas/`, `prompt.md`, `PROMPT-demo-entrega4.md`, `.sanitize-patterns`; remove the Prisma block and the duplicate Node block; keep `!.env.dev.example` after the `.env.*` rules. Create the local `.sanitize-patterns` (one regex per line; design Decision 1) [declares:sanitize-patterns]

## Phase 2: Sanitize (P2) — placeholder table in design.md

- [x] 2.1 Sanitize terraform: `terraform/README.md` (emails), `terraform/cicd/README.md`, `terraform/cicd/variables.tf` (delete `account_id` and `github_repo` defaults), `terraform/cicd/backend.hcl`, `terraform/envs/pilot/backend.hcl` [consumes:sanitize-patterns]
- [x] 2.2 Sanitize workflows + src: `.github/workflows/deploy.yml` (line 25 comment), `src/db/provision.ts` (line 38) [consumes:sanitize-patterns]
- [x] 2.3 Sanitize docs: `docs/10-deploy-pilot-aws.md` (all rows, personal names → role), `docs/03-auth-identidad-rbac.md`, `docs/02-hosting-infra-aws.md` (only if the gate hits), `docs/07-captura-dev-y-skill.md` (line 23 only) [consumes:sanitize-patterns]
- [x] 2.4 Sanitize openspec: `openspec/config.yaml` (line 28), `openspec/changes/archive/auth-two-gate/exploration.md`, `openspec/changes/archive/auth-two-gate/design.md`, `openspec/changes/archive/terraform-infra/design.md`, plus any other archive file the gate hits (sanitize only, no rename) [consumes:sanitize-patterns]

## Phase 3: Gate 1 + baseline commit (P3)

- [x] 3.1 Run the gate `rg -n --hidden -f .sanitize-patterns -g '!.sanitize-patterns' .` (or the grep -E -f equivalent); it must be empty. Extract `docs/LPMS_Cloud_Diseno_v0.6.docx` and `docs/artefactos/Crombie_Shared_Memory_Comparison.xlsx` into the scratchpad and scan their XML with the same patterns. On a binary hit, report file + category only and stop
- [x] 3.2 (orchestrator) `git init -b main`; check that `git ls-files` contains no excluded paths; baseline commit; `git checkout -b demo/e4`

## Phase 4: Rename + dead code (P4, P5) — rename map in design.md

- [x] 4.1 RED: edit `tests/auth/devAuthenticator.test.ts` (line 41), `tests/auth/oidc.test.ts` (lines 8, 43, 69) and `tests/mcp/registration.test.ts` (serverInfo name `gmemo`); confirm they fail [declares:gmemo-identity-tests]
- [x] 4.2 GREEN: `src/mcp/server.ts`, `src/index.ts`, `src/auth/devAuthenticator.ts`, `src/auth/devOidcAuthenticator.ts`, `src/contracts/tools.ts`, `src/contracts/memory.ts`, `src/judge/bedrockJudge.ts`; the tests from 4.1 pass [consumes:gmemo-identity-tests] [declares:DEV_PROMOTE_PRINCIPAL]
- [x] 4.3 Migrations: header refs in `migrations/0001_auth_tenancy.sql`, `migrations/0002_memory.sql`, `migrations/0003_staging.sql`, `migrations/0004_promotion_gaps.sql`; `migrations/seed.dev.sql` (project `gmemo`, remote `https://github.com/crombie-llc/gmemo-demo.git`, slug `gmemo-demo`, machine_credential principal, membership `contributor`, Decision 3) [consumes:DEV_PROMOTE_PRINCIPAL]
- [x] 4.4 New `tests/config/rateLimitGuard.test.ts`, cases (a)(b)(c) per Test Strategy. Prove it is not vacuous: temporarily disable the guard in `src/config/index.ts`, confirm (a) fails, restore, and record this in the result
- [x] 4.5 Terraform + workflows rename (D1): every file in design Area D and Area E (`gmemo-pilot-*`, `/gmemo/pilot/app`, `gmemo_master`, db `gmemo`, `Project="gmemo"`, `GMEMO_*`), plus the replacement warning at the top of `terraform/README.md`
- [x] 4.6 Docs + openspec rename: `docs/05-tipos-memoria-y-busqueda.md`, `docs/06-contrato-facade-y-datos.md`, `docs/10-deploy-pilot-aws.md`; `git mv`-equivalent renames of `docs/artefactos/lpms_schema_v2.sql` → `docs/artefactos/gmemo_schema_v2.sql`, `docs/artefactos/lpms_facade_contract_v1.md` → `docs/artefactos/gmemo_facade_contract_v1.md`, `docs/LPMS_Cloud_Diseno_v0.6.docx` → `docs/gmemo_Cloud_Diseno_v0.6.docx`; `openspec/config.yaml` (keep lines 10 and 95), `openspec/backlog.md` (+ rename note), `openspec/project-map.yaml`; `packages/web/README.md`. Respect the KEEP list
- [x] 4.7 Delete dead scaffolding: `packages/server/` (whole dir), `packages/infra/README.md`, `infra/docker-compose.yml`, `tsconfig.base.json`

## Phase 5: Runtime (P6, P7)

- [x] 5.1 Workspace + image: create `pnpm-workspace.yaml` and `packages/web/package.json`; update `package.json` (name, description, `smoke` script, lint includes `scripts`), `Dockerfile` (builder copies workspace manifests), `.dockerignore`, `docker-compose.yml` (pgvector, gmemo creds/image, `EMBEDDER_STUB`, `JUDGE_STUB_VERDICT`, comment), `.env.dev.example`. Run `pnpm install` (regenerates `pnpm-lock.yaml`), then `pnpm test -- --run`, `pnpm lint`, `pnpm build`, all green
- [x] 5.2 Create `scripts/smoke.ts` per the smoke contract (7 steps, JSON/SSE, exit 0/1/2); confirm the minimal `remember` fields for `gotcha`. Run `docker compose down -v && docker compose up --build -d`, wait for healthy, run `pnpm smoke` twice (both exit 0), `pnpm lint`, and `docker compose down` [consumes:DEV_PROMOTE_PRINCIPAL]

- [x] 5.3 Fix pre-existing DB integration failures surfaced by the compose DB gate: `tests/db/promotion.integration.test.ts` (pass `projectId` to `fetchPromotableItems`), `tests/db/memory.migrate.integration.test.ts` (cast `$1`), and DB test isolation in `vitest.config.ts` (DB files must not clobber each other); refresh stale test counts in `README.md`

## Phase 6: Docs + specs baseline (P8, P9)

- [x] 6.1 Rewrite `DEVELOPMENT.md` (pnpm, Node 22, compose up / down -v, only scripts that exist, `.env.dev.example` for host dev, `pnpm smoke`, the build needs internet for the RDS CA, workspace note); update `README.md` (title gmemo, keep the line 3 predecessor wording, new remote in curl examples, env list matching `src/config/index.ts`)
- [x] 6.2 Consolidate specs per the design mapping: create `openspec/specs/mcp-facade/spec.md`, `openspec/specs/auth/spec.md`, `openspec/specs/memory-read/spec.md`, `openspec/specs/staging/spec.md`, `openspec/specs/hybrid-search/spec.md`, `openspec/specs/promotion/spec.md`, `openspec/specs/bedrock-clients/spec.md`, `openspec/specs/http-security/spec.md`, `openspec/specs/infrastructure/spec.md`, `openspec/specs/dev-harness/spec.md` (current-state form, a `Source:` line per requirement, a `## History` table, gmemo names, placeholders); delete `openspec/specs/.gitkeep`

## Phase 7: Gate 2 + commit (P10)

- [x] 7.1 (verify) Sanitization gate empty; `rg -i lpms -g '!openspec/changes/archive/**'` returns only KEEP hits; artefact-reference grep empty; suite, lint and build green; smoke exit 0
- [ ] 7.2 (orchestrator) C0 commit on `demo/e4` after verify + archive
