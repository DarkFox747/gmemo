# Proposal: demo-baseline (C0) — hygiene, gmemo rename, bootable compose

## Intent

The TFG prototype must be published (public code + instructions) and must run with `docker compose up --build` with no AWS account. Today:
- The compose stack **does not boot**: there is no pgvector and `EMBEDDER_STUB` is missing.
- The repo carries **sensitive data**: AWS account ID, operator IP, hosted zone, work emails, real domain and bucket names.
- The product is called LPMS/lpms-cloud instead of **gmemo**.
- There are dead placeholders (`packages/server` with Prisma, `infra/docker-compose.yml`), and DEVELOPMENT.md describes a stack that no longer exists.
- `openspec/specs/` is empty.

This change leaves a clean, publishable and bootable baseline that C1–C8 build on.

## Scope

### In Scope
1. **`.gitignore`**: `.claude/`, `.claude.json`, `.mcp.json`, `entrevistas/`, `prompt.md`, `PROMPT-demo-entrega4.md`.
2. **Sanitization** (before the first commit) with placeholders `<AWS_ACCOUNT_ID>`, `<OPERATOR_IP>/32`, `<HOSTED_ZONE_ID>`, `<ADMIN_EMAIL>`, `<DOMAIN>`, `<GITHUB_ORG>/<REPO>`, `<TFSTATE_BUCKET>`, `<TFLOCK_TABLE>`, `<OIDC_ROLE_NAME>`, `<COMPANY_DOMAIN>`. Covers docs/, openspec/ (including the archive), workflows, terraform/ and `src/db/provision.ts`. Templated ARNs are kept. The `.docx` is scanned by unzipping it.
3. **Product rename LPMS → gmemo** in code, tests, compose (db `gmemo`, image `gmemo:dev`), `package.json` (`name: "gmemo"`), MCP serverInfo, dev scope (`gmemo.memory/read`), seed (project "gmemo (local dev)", remote `https://github.com/crombie-llc/gmemo-demo.git`), dev OIDC principal (`crombie-llc/gmemo-demo`), workflows (`LPMS_*` → `GMEMO_*`), artefact files (`gmemo_schema_v2.sql`, `gmemo_facade_contract_v1.md`, `gmemo_Cloud_Diseno_v0.6.docx`) and every reference to them, README, docs, openspec config/backlog/project-map.
4. **Delete** `packages/server`, `packages/infra`, `infra/docker-compose.yml`, `tsconfig.base.json`.
5. **pnpm workspace**: `pnpm-workspace.yaml` (`packages/*`), a minimal `packages/web/package.json` (`@gmemo/web`, private, no dependencies), a regenerated lockfile, and a Dockerfile that copies the workspace manifests before `--frozen-lockfile`.
6. **Compose**: `pgvector/pgvector:pg16`, `EMBEDDER_STUB: "true"`, `JUDGE_STUB_VERDICT: "accepted"`; `.env.dev.example` reconciled with compose; `.dockerignore` excludes `packages/` except web manifests.
7. **Smoke test** `scripts/smoke.ts` (`pnpm smoke`, Node `fetch`, no dependencies): `GET /health`, MCP `initialize` + `recall` + `remember` + `list_staged`, `POST /promote` (bypass) and idempotency (second call). It runs against the compose stack and exits 0 only if everything passes.
8. **Docs**: rewrite DEVELOPMENT.md (pnpm, compose, scripts, smoke test); update README for the rename and env vars.
9. **Specs**: consolidate the 12 archived specs into `openspec/specs/{domain}/spec.md` (the specs baseline for C1+).
10. **Guard**: a test for `RATE_LIMIT_ENABLED=false` under `NODE_ENV=production` (closes the gap in "every bypass impossible in production, with a test").
11. **Git**: `git init`, baseline commit **after** the sanitization grep comes back empty, branch `demo/e4`, C0 commit.

### Out of Scope
- `.claude/` (tooling, gitignored): it is neither sanitized nor modified.
- LPMS references as the **orchestrator's memory tool** (`cache_store: lpms`, lpms-convention) and the "LPMS local predecessor" wording (`docs/01`, `README:3`, `config.yaml:10`): these are historically accurate and are kept.
- The *content* of archived changes: frozen, sanitization only (no LPMS rewriting), plus a rename note in the backlog.
- Physical names of the **live AWS pilot** (see Decision D1).
- Renaming GitHub repository variables (out-of-band, documented).
- Text diagrams in PNGs (manual review by Diego).

## Approach

Three steps, in order:
1. **Gitignore + sanitize + rename** with an explicit file list from `exploration.md` §4–5. No global `sed`, so category (d) is excluded. Verify by grep.
2. **Runtime**: delete dead code, workspace, Dockerfile, compose, smoke script. Run `docker compose down -v && docker compose up --build` + `pnpm smoke`.
3. **Docs + specs + git**.

Verification grep (must be empty outside `.git/`, `.claude/`, `node_modules/` and the gitignored files):
the patterns listed in the gitignored local file `.sanitize-patterns` (gate: `rg -f .sanitize-patterns`; see design Decision 1).

## Decisions to confirm

- **D1 — Terraform for the live pilot**: `lpms-pilot-*`, `lpms_master`, db `lpms` and `/lpms/pilot/app` are physical identifiers. Renaming them forces RDS and Secrets Manager replacement on the next `terraform apply`. **Proposal: rename them to `gmemo-*`** (the demo is local and the pilot is out of scope for E4) and document in `terraform/README.md` that applying over the current pilot recreates the DB. Alternative: keep them as a documented exception.
- **D2**: the dev slug `crombie-dev/lpms-cloud` → `crombie-llc/gmemo-demo` (seed, dev OIDC, tests).

## Constraints

- pnpm only. No new dependencies (the smoke test uses Node 22 `fetch` + `tsx`, which is already a dev dependency).
- The suite (`pnpm test -- --run`), `pnpm lint` and `pnpm build` must stay green.
- Prod guards intact.
- Do not touch `.claude/` or `.mcp.json`.

## Affected Areas

| Area / Module | Impact | Description |
|---|---|---|
| repo root (gitignore, package.json, workspace, Dockerfile, compose, .dockerignore, .env examples) | Modified/New | Hygiene, workspace, bootable compose |
| `packages/` | Removed/New | Delete server/infra; minimal `web` |
| `src/auth`, `src/mcp`, `src/db`, `src/index.ts` | Modified | Rename identifiers (no logic) |
| `migrations/seed.dev.sql` + headers | Modified | Rename seed and slug |
| `tests/auth`, `tests/config` | Modified/New | Rename assertions; rate-limit guard test |
| `scripts/` | New | Smoke test |
| `docs/` | Modified/Renamed | Sanitization + rename + artefacts |
| `.github/workflows`, `terraform/` | Modified | Sanitization + rename (D1) |
| `openspec/` | Modified/New | Sanitization, rename, consolidated specs |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Rename breaks tests or the orchestrator tooling | Med | Explicit list, category (d) excluded, full suite run |
| Frozen lockfile fails in Docker after the workspace change | Med | Regenerate the lockfile with `pnpm install` and COPY the manifests |
| Something sensitive slips into the first commit | Low | Blocking grep before `git init`, plus `.docx` XML scan |
| SSE response / MCP handshake differs from what we expect | Med | Smoke test parses JSON or SSE and sends `initialize` |
| Docker build without internet (RDS CA bundle) | Low | Document it in DEVELOPMENT |
| D1: someone applies Terraform over the live pilot | Low | Warning in the README |

## Rollback Plan

Before the first commit, a full copy of the directory (`gmemo-pre-c0` backup next to the repo, outside OneDrive if possible) is the revert point. After the commit: `git revert` of the C0 commit, or `git reset` to the baseline commit.

## Dependencies

- Docker Desktop running, and internet access for the build.
- `pnpm install` (no `node_modules` yet).

## Success Criteria

- [ ] `docker compose down -v && docker compose up --build`: db, migrate and app healthy from scratch.
- [ ] `pnpm smoke` exits 0 (health, recall, remember, list_staged, promote, idempotent promote).
- [ ] `pnpm test -- --run`, `pnpm lint`, `pnpm build` green.
- [ ] Sanitization grep empty; `.docx` scanned.
- [ ] `grep -ri lpms` only returns category (d), the predecessor wording, and the archive.
- [ ] `openspec/specs/` holds the consolidated specs.
- [ ] Repo on `demo/e4` with baseline commit + C0 commit; `.claude/` and the other excluded files untracked.
