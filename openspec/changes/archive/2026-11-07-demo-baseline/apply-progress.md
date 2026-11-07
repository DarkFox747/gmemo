# Apply Progress: demo-baseline

## Batch 1 — 2026-11-07 (orchestrator + crombie-worker)

### Completed
- [1.1] `.gitignore` updated (tooling, personal material, `.sanitize-patterns`, `dist-demo/`; Prisma block removed); local `.sanitize-patterns` created (orchestrator, inline)
- [2.1] Terraform sanitized; `account_id` / `github_repo` defaults removed in `terraform/cicd/variables.tf`; `backend.hcl` placeholders
- [2.2] `.github/workflows/deploy.yml` comment and `src/db/provision.ts` doc example sanitized (comment-only)
- [2.3] `docs/10`, `docs/03`, `docs/07` sanitized; personal names → role nouns; `docs/02` had no hits (untouched)
- [2.4] `openspec/config.yaml` and archived `auth-two-gate/{exploration,design}.md`, `terraform-infra/design.md` sanitized (no rename)
- [3.1] Gate empty (re-verified by orchestrator: 0 hits; no third-party personal names). `.docx` and `.xlsx` XML scanned clean

### Files changed
- .gitignore, .sanitize-patterns (local, ignored)
- terraform/README.md, terraform/cicd/README.md, terraform/cicd/variables.tf, terraform/cicd/backend.hcl, terraform/envs/pilot/backend.hcl
- .github/workflows/deploy.yml, src/db/provision.ts
- docs/10-deploy-pilot-aws.md, docs/03-auth-identidad-rbac.md, docs/07-captura-dev-y-skill.md
- openspec/config.yaml, openspec/changes/archive/auth-two-gate/exploration.md, openspec/changes/archive/auth-two-gate/design.md, openspec/changes/archive/terraform-infra/design.md

### Deviations
- orchestrator: no `rg` on the host; the gate is `grep -rnIE -f .sanitize-patterns` with explicit excludes (scratchpad `gate.sh`). `.sanitize-patterns` also covers the bare company domain, live repo slug and OIDC role
- 3.1: binaries extracted with PowerShell `ZipFile` (bsdtar failed); scratch dirs left in the session scratchpad

### Issues
None

---

## Batch 2 — 2026-11-07 (3 parallel crombie-workers)

### Completed
- [4.1] Identity tests edited (`gmemo.memory/read`, `crombie-llc/gmemo-demo`, `aud: 'gmemo'`, serverInfo `gmemo` assertion added to registration test)
- [4.2] src rename (serverInfo, boot log, dev scope, dev OIDC principal, artefact refs)
- [4.3] Migration header refs; seed → project `gmemo`, remote `crombie-llc/gmemo-demo`, membership `contributor`
- [4.5] Terraform + workflows rename (19 files), replacement warning at top of `terraform/README.md`, GitHub `GMEMO_*` out-of-band note (verified by orchestrator)
- [4.6] Docs/openspec rename; artefacts renamed with `git mv`; backlog rename note; project-map entries for workspace/smoke/guard test
- [4.7] `packages/server/`, `packages/infra/README.md`, `infra/docker-compose.yml`, `tsconfig.base.json` removed (`git rm`)

### Files changed
- tests/auth/devAuthenticator.test.ts, tests/auth/oidc.test.ts, tests/mcp/registration.test.ts, tests/config/rateLimitGuard.test.ts (new)
- src/mcp/server.ts, src/index.ts, src/auth/devAuthenticator.ts, src/auth/devOidcAuthenticator.ts, src/contracts/tools.ts, src/contracts/memory.ts, src/judge/bedrockJudge.ts
- migrations/0001..0004 (headers), migrations/seed.dev.sql
- terraform/** (19 files), .github/workflows/deploy.yml, .github/workflows/promote.yml
- docs/05, docs/06, docs/10, docs/artefactos/gmemo_schema_v2.sql, docs/artefactos/gmemo_facade_contract_v1.md, docs/gmemo_Cloud_Diseno_v0.6.docx, openspec/config.yaml, openspec/backlog.md, openspec/project-map.yaml, packages/web/README.md
- deleted: packages/server/**, packages/infra/README.md, infra/docker-compose.yml, tsconfig.base.json

### Deviations
- 4.1: RED not observed — src edited before any test run (no test runner available)
- 4.6: project-map.yaml was already invalid YAML before C0; orchestrator fixed it (8 "key: text + list" lines → key with comment, 1 list item quoted); now parses
- orchestrator: the 4.5 worker returned no envelope; result verified by orchestrator (grep, git status, gate)

### Issues
- 4.4: PARTIAL — `tests/config/rateLimitGuard.test.ts` written but unverified; non-vacuity proof pending. pnpm is not installed on the host (corepack present but not enabled) and the package-manager hook blocked the frozen-lockfile dependency install. No test, lint or build has run yet in this change.

---

## Batch 3 — 2026-11-07 (3 parallel crombie-workers, edits only)

### Completed
- [5.1 edits] `pnpm-workspace.yaml`, `packages/web/package.json`, `package.json` (name gmemo, `smoke`, lint incl. `scripts`), `Dockerfile` (workspace manifests before frozen install), `.dockerignore`, `docker-compose.yml` (pgvector, gmemo, `EMBEDDER_STUB`, `JUDGE_STUB_VERDICT=accepted`)
- [5.2 edits] `scripts/smoke.ts` (7 steps, JSON/SSE, exit 0/1/2); `remember` gotcha needs no `fields`; PromoteOutcome names confirmed (`status`, `applied`)
- [6.1] `DEVELOPMENT.md` rewritten; `README.md` updated (only predecessor-wording LPMS remains)
- [6.2] 10 consolidated specs under `openspec/specs/`; `.gitkeep` removed; no unplaced archived requirement

### Files changed
- pnpm-workspace.yaml (new), packages/web/package.json (new), package.json, Dockerfile, .dockerignore, docker-compose.yml, scripts/smoke.ts (new)
- DEVELOPMENT.md, README.md
- openspec/specs/{mcp-facade,auth,memory-read,staging,hybrid-search,promotion,bedrock-clients,http-security,infrastructure,dev-harness}/spec.md (new); openspec/specs/.gitkeep (deleted)

### Deviations
- 6.2: test-coverage requirements folded into one per domain (REQ ids not 1:1); `infrastructure` also states the README warning + required inputs (from design Decision 4)
- 5.2: script is run by `tsx`, not type-checked by `tsc` (scoped to `src`); linted via `eslint src tests scripts`

### Issues
- 5.1: `.env.dev.example` NOT updated — a permission deny rule blocks agents from reading/writing `.env*`; exact target content handed to the human
- 5.1/5.2: lockfile regeneration, suite/lint/build, compose boot and smoke run pending the human pnpm setup

---

## Batch 4 — 2026-11-07 (verification runs + fixes)

### Completed
- [4.4] rate-limit guard test green; non-vacuity proven (guard disabled → case (a) failed → restored, empty diff)
- [5.1] lockfile regenerated by the human (+2 lines, `packages/web` importer); suite 466 passed / 89 skipped, lint 0, build 0
- [5.2] compose healthy from scratch; `pnpm smoke` ×2 exit 0
- [5.3] DB gate deterministic: 555/555 against compose Postgres (test fixes, serial DB files, `tests/globalSetup.ts` schema reset guarded to localhost + db `gmemo`)
- [7.1] gate 2: sanitization 0 hits, lpms only KEEP (+ human-owned `.env.dev.example`), no old artefact refs

### Files changed
- docker-compose.yml (healthcheck 127.0.0.1, ports `127.0.0.1:5433:5432` / `127.0.0.1:3000:3000`), DEVELOPMENT.md (port note, dev-only warning), README.md (test counts)
- tests/db/promotion.integration.test.ts, tests/db/memory.migrate.integration.test.ts, tests/db/staging.migrate.integration.test.ts, vitest.config.ts, tests/globalSetup.ts (new)
- .gitignore (+CLAUDE.md), CLAUDE.md untracked

### Deviations
- 5.2: db host port 5433 (host 5432 taken by a local PostgreSQL service); healthcheck 127.0.0.1 (busybox `localhost` → ::1)
- 5.3: one-time schema reset in vitest globalSetup instead of rewriting every suite's teardown
- orchestrator: package-manager hook adjusted at the user's request (flag-only `pnpm install` allowed); a second refinement was denied by the permission classifier and the human ran the install

### Issues
- R1-CR1: `.env.dev.example` pending the human edit (agents cannot read/write `.env*`)

---
