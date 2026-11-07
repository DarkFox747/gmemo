# Exploration: demo-baseline (C0)

Two crombie-explore scopes (2026-11-07): (A) rename + sanitization inventory, (B) runtime/build/dev-env.
Status: A = PARTIAL (binaries not text-scanned), B = COMPLETE.

## 1. Compose does not boot today (B, high)

| Problem | Evidence | Fix |
|---|---|---|
| `postgres:16` has no pgvector; `0005` runs `CREATE EXTENSION vector` → migrate fails, app never starts | `docker-compose.yml:3`, `migrations/0005_embeddings.sql:24` | `pgvector/pgvector:pg16` (already used in `infra/docker-compose.yml:5`) |
| `EMBEDDER_STUB` missing → config requires `BEDROCK_EMBEDDING_MODEL_ID` + `AWS_REGION` → `process.exit(1)` | `src/config/index.ts:59-62,182-189,203-216` | `EMBEDDER_STUB: "true"` |
| `JUDGE_STUB_VERDICT` defaults to `uncertain` → seeded item is never promoted in a smoke test | `src/config/index.ts:43`, `.env.dev.example:35-38` | `JUDGE_STUB_VERDICT: "accepted"` in compose |
| Rate limit ON (`/promote` 10/min) | `src/config/index.ts:86-94` | Smoke script stays under the limit; no change |

Compose has no `env_file` and no `${}` interpolation: `.env.dev.example` never reaches the containers. That makes compose the source of truth for the dev env.

## 2. Workspace and Docker (B, high)

- `packages/server` is a real package (`@lpms/server`, Prisma, express 4) that is NOT in the lockfile. Globbing `packages/*` breaks the frozen install. It is dead: only DEVELOPMENT.md references it. **Delete it** together with `tsconfig.base.json`, which only it consumes.
- `packages/infra` and `packages/web` hold only a README. `infra/docker-compose.yml` is a dead duplicate (db only, same port 5432).
- `Dockerfile:7-8` copies only `package.json` + `pnpm-lock.yaml`. With a workspace it must also COPY `pnpm-workspace.yaml` + `packages/web/package.json`, and the lockfile must be regenerated (`pnpm install`) so it carries the `packages/web` importer.
- Root `tsc` (`include: src`), `vitest` (`tests/**`) and `eslint src tests` do NOT pick up `packages/`.
- The Dockerfile downloads the RDS CA bundle at build time, so the build needs internet access.
- `.dockerignore` does not exclude `packages/` or `infra/` (cosmetic).

## 3. Runtime facts for the smoke test (B)

- `migrate.ts`: one transaction per file, ledger `schema_migrations`, filter `^\d{4}_.*\.sql$`, no advisory lock. → C4 `ADD VALUE` goes in its own file.
- Seed `seed.dev.sql` (only `NODE_ENV=development`): user `dev@localhost`, project `lpms-cloud`, repo remote `https://github.com/crombie-dev/lpms-cloud.git`, 4 memories, machine credential `crombie-dev/lpms-cloud`, open session on `main` with 1 pending `add` item.
- MCP: stateless Streamable HTTP `POST /mcp`, required header `X-Git-Remote`, optional `X-Git-Branch`. The response may be SSE-framed; send `initialize` first to be safe (unverified).
- `/promote` (dev bypass): strict body `{repo, source_branch, pr_number?, merge_sha?}`; `repo` must equal `devOidcAuthenticator` principal (`crombie-dev/lpms-cloud`, `refs/heads/main`).
- Prod guard: `superRefine` in `src/config` + second structural check in `src/index.ts`. Gap: no test for `RATE_LIMIT_ENABLED=false` under production.

## 4. Rename inventory (A)

~250 case-insensitive `lpms` occurrences in ~72 files (~60 under `openspec/changes/archive/`). `gmemo` appears nowhere.

- **(a) code identifiers**: `package.json:2,4`; `src/mcp/server.ts:15` (serverInfo name); `src/index.ts:218`; `src/auth/devAuthenticator.ts:22` (scope `lpms.memory/read`); `src/auth/devOidcAuthenticator.ts:23,26`; `docker-compose.yml` (db user/pass/name, image); `migrations/seed.dev.sql:15,23,74,81`; `.github/workflows/promote.yml` (`LPMS_OIDC_AUDIENCE`, `LPMS_PROMOTE_URL`); file headers in `migrations/000{1..4}`, `src/contracts/*.ts`, `src/judge/bedrockJudge.ts:42`.
- **Tests that hard-code these strings**: `tests/auth/devAuthenticator.test.ts:41`, `tests/auth/oidc.test.ts:8,43,69`.
- **(b) prose**: README, DEVELOPMENT, `docs/0{1,5,6,7}`, `docs/10`, `openspec/{backlog,config,project-map}`, `terraform/README.md` (21), `terraform/cicd/README.md`.
- **(c) files**: `docs/artefactos/lpms_facade_contract_v1.md`, `docs/artefactos/lpms_schema_v2.sql`, `docs/LPMS_Cloud_Diseno_v0.6.docx` (binary). Referenced from project-map, config, DEVELOPMENT, docs/06, migration/contract headers.
- **(d) orchestrator tool, DO NOT rename**: `openspec/config.yaml:95` (`cache_store: lpms`), `docs/07:39,43` (lpms-convention). `docs/01:4,13,28,34`, `openspec/config.yaml:10` and `README.md:3` describe LPMS as the **local predecessor** (SQLite per dev); those stay as historical wording.
- **Live AWS pilot**: Terraform uses `lpms-pilot-*`, `lpms_master`, db `lpms`, `/lpms/pilot/app`, tag `Project="lpms"`. Renaming them forces RDS and Secrets replacement on the next `apply`. There is also a third live name (domain, GitHub repo, state bucket, OIDC role) → placeholders.

## 5. Sanitization inventory (A)

Real hits are concentrated in:
- `docs/10-deploy-pilot-aws.md`: account ID (8,84,86,87), hosted zone (9), live domain (9,61,75,144), operator IP (60), two work emails (62), personal names (200), repo slug and state bucket (10,20-21,26,56-57,146,166,177-179).
- `.github/workflows/deploy.yml:25` (account ID + OIDC role in a comment).
- `terraform/cicd/variables.tf:10,21` (account ID and repo as defaults) and `terraform/cicd/README.md`.
- `terraform/{envs/pilot,cicd}/backend.hcl` (state bucket and lock table).
- company email domain: `openspec/config.yaml:28`, `docs/02:40`, `docs/03:9`, `terraform/README.md:249,276,321`, archive (`auth-two-gate`, `terraform-infra`).
- `src/db/provision.ts:38` (repo slug). `docs/07:23` (personal name).
- No literal Cognito pool or client IDs. The 12-digit numbers in tests are UUID fragments (false positives).
- **KEEP**: templated ARNs (`terraform/cicd/main.tf:16-22`, `bootstrap/main.tf:82-83`), the AWS managed policy ARN, `pilot.tfvars.example` (already sanitized), RFC 5737/1918 ranges.
- **Not scanned**: `.docx`, `.xlsx` and `docs/artefactos/*.png`. A `.docx` is a zip, so its XML can be grepped. The PNGs need a manual check.

## 6. Docs and tooling

- DEVELOPMENT.md is obsolete: npm, Prisma, `packages/server`, scripts that don't exist, and `cp .env.example`. README has a stale env list.
- `.gitignore` does not exclude `.claude/`, `.claude.json`, `.mcp.json`, `entrevistas/`, `prompt.md`, `PROMPT-demo-entrega4.md`.
- `openspec/specs/` is empty; 12 archived specs live in `changes/archive/*/specs/`.
- Cross-cutting: `.claude/rules/tests.md` prescribes node:test + npm, which contradicts the real stack (Vitest + pnpm). It is framework tooling and is not touched in this change.
