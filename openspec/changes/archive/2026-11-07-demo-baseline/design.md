# Design: demo-baseline (C0) — hygiene, gmemo rename, bootable compose

> **Authoring rule for every C0 artefact (this file, tasks.md, apply-progress, verify-report, commit messages):**
> never write a literal sensitive value (account ID, operator IP, hosted zone ID, work emails, live domain,
> live repo slug, state bucket/lock table, live OIDC role). Refer to them by placeholder or by
> "the patterns in `.sanitize-patterns`". The proposal and the repository-hygiene spec currently embed the
> verification regex literally, which makes the gate match itself and leaks the account ID into history
> (see Decision 1).

## Technical Approach

C0 is mostly mechanical, so the design is mainly about **ordering, file ownership and gates**, plus four small pieces of real code: the compose/Dockerfile/workspace fixes, `scripts/smoke.ts`, one new config guard test, and a one-line seed RBAC fix that the smoke test needs.

1. **Hygiene before history.** `.gitignore` and a local-only pattern file come first. Then sanitization runs over an explicit file list (exploration §5), never a global `sed`. A blocking gate (`rg -f .sanitize-patterns` + `.docx`/`.xlsx` XML scan) must come back empty before `git init`.
2. **Baseline = sanitized original.** The first commit on `main` is the original prototype with *only* sanitization and `.gitignore` applied. Everything else (rename, dead-code removal, workspace, compose, smoke, docs, specs) lands on `demo/e4` as the C0 commit, so the C0 diff can be reviewed on its own.
3. **Rename by explicit map** (table below). Category (d) and the predecessor wording are on a KEEP list, and archived changes are only sanitized.
4. **Runtime fixes reuse existing patterns.** `pgvector/pgvector:pg16` is the image already used in the dead `infra/docker-compose.yml`. Stub flags are the ones `src/config/index.ts` already defines. Compose inline env stays the single source of truth. The Dockerfile keeps its two-stage shape and only copies the workspace manifests before the frozen install.
5. **Smoke test** is a standalone `tsx` script that uses Node 22 `fetch`, with no SDK client and no new dependencies. It speaks raw JSON-RPC over Streamable HTTP and accepts JSON or SSE framing.
6. **Specs baseline.** The 12 archived specs are consolidated into 10 capability specs under `openspec/specs/`. The `repository-hygiene` delta from this change is synced at C0 archive time.

### Execution phases (strict order; groups inside a phase run in parallel)

| Phase | What | Areas (parallel groups) | Who runs it |
|---|---|---|---|
| P0 | Full backup copy `gmemo-pre-c0` next to the repo (outside OneDrive if possible) | — | **Human** |
| P1 | `.gitignore` (+ drop the Prisma lines) and create local `.sanitize-patterns` | A | agent |
| P2 | **Sanitize** (placeholder table) | B-san (`src/db/provision.ts`), D, E, F, G | agent |
| P3 | **Gate 1**: `rg -f .sanitize-patterns --hidden` over the tree (gitignored paths excluded by rg's defaults) plus the docx/xlsx XML scan, which must be empty. Then `git init -b main`, check `git ls-files` (no excluded paths), baseline commit, `git checkout -b demo/e4` | — | agent prepares; **human confirms** the empty gate and runs/approves `git init` + commit |
| P4 | **Rename** (rename map). TDD: test edits first (they go red), then source edits | B, C, D, E, F, G | agent |
| P5 | Delete dead scaffolding | H | agent |
| P6 | Workspace + Dockerfile + compose + env example + `package.json` | A | agent, then **human/network**: `pnpm install` (regenerates `pnpm-lock.yaml`), `pnpm test -- --run`, `pnpm lint`, `pnpm build` |
| P7 | `scripts/smoke.ts` | I | agent, then **human (Docker daemon)**: `docker compose down -v && docker compose up --build`, then `pnpm smoke` in a second shell |
| P8 | Docs: `DEVELOPMENT.md` rewrite, `README.md` update | A-docs | agent |
| P9 | Specs consolidation | J | agent |
| P10 | **Gate 2**: sanitization gate again, `rg -i lpms` (only KEEP/archive hits), artefact-reference grep, suite/lint/build green, smoke exit 0. Then the C0 commit on `demo/e4` | — | agent prepares; **human approves** the commit |

Dependencies that force the order: P2 before P3 (no secret in history). P4 before P6 (compose/seed names must agree with `DEV_PROMOTE_PRINCIPAL` before the stack boots). P5 before P6 (`packages/server` breaks the frozen install once the `packages/*` glob exists). P6 before P7 (the smoke test needs a bootable stack). P4–P7 before P8 (docs describe final names and commands).

## Architecture Decisions

### Decision 1: Verification patterns live in a gitignored `.sanitize-patterns` file

**Choice**: Create `.sanitize-patterns` at the repo root, with one regex per line (the 7 alternatives from the proposal's gate, plus the live repo slug and the live OIDC role name). Add it to `.gitignore`. The gate is `rg -n --hidden -f .sanitize-patterns -g '!.sanitize-patterns' .`. Rewrite `proposal.md` §Approach, `exploration.md` §4–5 and `specs/repository-hygiene/spec.md` (scenario "Sanitization grep is empty") so they reference the file instead of embedding the literal regex and values.
**Alternatives considered**: (a) Keep the literal regex in committed docs. It matches itself, so the gate can never be empty, and it publishes the account ID. (b) Obfuscate with character classes (`[4]`). The gate works, but the value is still readable in history. (c) Exclude `openspec/changes/demo-baseline/` from the gate. That hides real leaks in the change's own artefacts (exploration line 48 already contains the live domain).
**Rationale**: This is the only option that keeps the gate both meaningful and empty while publishing nothing sensitive. The ARN pattern is generic, but it also lives in the file to keep a single source.
**Reversible**: Yes. It is a local file; a future maintainer can recreate it from the placeholder table.

### Decision 2: Baseline commit is the sanitized original; C0 is a separate commit on `demo/e4`

**Choice**: P3 commits original code + `.gitignore` + sanitization on `main`. P4–P9 become one C0 commit on `demo/e4`.
**Alternatives considered**: `git init` at the very end with baseline = final tree. That leaves nothing to diff against and loses the "before" snapshot for the TFG.
**Rationale**: It satisfies "sanitize before git init" and gives a reviewable C0 diff. Sanitized files are touched twice (P2, then P4), but sequentially, so there are no conflicts.
**Reversible**: Yes. Before P3, restore from the P0 backup. After P3, `git reset --hard` to the baseline commit.

### Decision 3: Dev seed membership becomes `contributor`

**Choice**: `migrations/seed.dev.sql` step 4 changes `'viewer'` to `'contributor'`.
**Alternatives considered**: Leave the smoke test read-only (it would drop the `remember`/`list_staged` steps that the proposal requires). Add a second dev user (more seed and more principals, which is YAGNI).
**Rationale**: `RdsAuthorizer` (`src/auth/authorizer.ts:42-45`) puts `remember`, `list_staged` and `discard_staged` behind `WRITE_ROLES = {project_admin, contributor, service_agent}`. The seeded dev user is only `viewer`, so the smoke test's write steps would be denied today. `contributor` is a superset of viewer for reads. The seed is dev-only (refused under production), so no prod surface changes. **This is a gap in the proposal**, resolved here because it stays within scope (seed is already being edited).
**Reversible**: Yes, one line.

### Decision 4: Terraform physical names renamed (D1); live-only defaults removed, not placeholdered

**Choice**: Rename `lpms-pilot-*` → `gmemo-pilot-*`, `/lpms/pilot/app` → `/gmemo/pilot/app`, secret `lpms/pilot/app` → `gmemo/pilot/app`, `lpms_master` → `gmemo_master`, db `lpms` → `gmemo`, tag `Project="lpms"` → `"gmemo"`. In `terraform/cicd/variables.tf`, **delete the `default`** of `account_id` and `github_repo` (they become required inputs) instead of setting them to placeholder strings. `backend.hcl` files get `"<TFSTATE_BUCKET>"` / `"<TFLOCK_TABLE>"` plus a "fill before `terraform init`" comment. Add a **warning block** at the top of `terraform/README.md`: applying over the existing pilot replaces RDS (data loss unless snapshotted), Secrets Manager, ECS, ALB, and also the ECR repo, log group and IAM roles.
**Alternatives considered**: A placeholder default such as `"<AWS_ACCOUNT_ID>"`. Plan would succeed with an invalid value baked into the IAM trust policy, which is a silent failure. Keeping `lpms-*` as a documented exception was rejected by the user (D1).
**Rationale**: Required variables fail loudly at plan time (fail safely). Placeholders in `.hcl` are acceptable because `terraform init` fails visibly on them.
**Reversible**: Partial. The repo change reverts trivially. A real `apply` is irreversible (resource replacement); that is what the README warning is for.

### Decision 5: Workspace keeps the root as the server package; `packages/web` is a manifest-only importer

**Choice**: `pnpm-workspace.yaml` with `packages: ['packages/*']`. The root `package.json` stays the server (`name: "gmemo"`). `packages/web/package.json` = `{ "name": "@gmemo/web", "version": "0.0.0", "private": true }`. The lockfile is regenerated with `pnpm install` (human/network). The Dockerfile still builds only the root.
**Alternatives considered**: Moving the server into `packages/server` (large move, breaks every path in the project-map and tests). Keeping `packages/server` and excluding it with `!packages/server` (keeps dead Prisma code; rejected in the proposal).
**Rationale**: This is the minimal change that makes later frontend work possible without moving code. Root `tsc`/`vitest`/`eslint` are scoped to `src`/`tests`, so they are unaffected.
**Reversible**: Yes. Delete the two files and regenerate the lockfile.

### Decision 6: Smoke test speaks raw JSON-RPC, not the MCP SDK client

**Choice**: `scripts/smoke.ts` uses only `fetch`. It POSTs JSON-RPC to `/mcp` and parses the response as JSON or `text/event-stream`, based on `Content-Type`.
**Alternatives considered**: `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` (already a dependency). It hides the SSE/header behavior we want to verify. The SDK client is also stateful and expects session semantics, while our server is stateless (`sessionIdGenerator: undefined`, `src/mcp/transport.ts:55`).
**Rationale**: This is the same black-box view a curl user gets, and it documents the wire contract. Parsing is about 20 lines.
**Reversible**: Yes.

### Decision 7: Rate-limit prod guard test lives in a new file `tests/config/rateLimitGuard.test.ts`

**Choice**: A new file following the `prodGuard.test.ts` pattern (`vi.resetModules` + dynamic import, `process.exit` spy that throws, env restored in `afterEach`).
**Alternatives considered**: Appending to `prodGuard.test.ts`. Its header and describe block are specific to AUTH_DEV_BYPASS, and the other guards each have their own file (`embedderGuards`, `promoteConfig`).
**Rationale**: One guard per file is the existing local convention.
**Reversible**: Yes.

### Decision 8: Spec consolidation into 10 capability domains; requirements in current-state form

**Choice**: See the mapping table. Each consolidated spec uses the `repository-hygiene` format (`## Purpose`, `## Requirements`, `### Requirement:` + `#### Scenario:` where the archive had acceptance criteria). Every requirement carries a `Source: <archived-change>` line. When a later change superseded an earlier requirement (for example, scaffold stub read tools replaced by the real `data-model` wiring), the current behavior is stated once, and the superseded text is listed in a `## History` table at the end of the spec (requirement, source, superseded-by). That way "each archived requirement appears in exactly one spec" holds without contradictory requirements. "Out of scope", "Acceptance Criteria" and "Tests + gate" sections are not requirements: acceptance criteria become scenarios, and the rest is dropped. Consolidated specs are new files outside the archive, so they **use gmemo naming and placeholders**.
**Alternatives considered**: One spec per archived change (preserves the history structure, but later deltas would scatter across change-named files). Verbatim copy (keeps contradictions and lpms names in non-archive files, which fails the rename gate).
**Rationale**: Capability-named files are stable targets for C1+ deltas.
**Reversible**: Yes.

## Data Flow

### Compose boot (from scratch)

    docker compose up --build
      db  (pgvector/pgvector:pg16, gmemo/gmemo/gmemo) ──healthy──┐
                                                                  ▼
      migrate (gmemo:dev) node dist/db/migrate.js  → 0001..0006 (0005 CREATE EXTENSION vector OK)
                          node dist/db/seed.js     → seed.dev.sql (NODE_ENV=development)
                                                                  │ completed_successfully
                                                                  ▼
      app (gmemo:dev) loadConfig(): AUTH_DEV_BYPASS, JUDGE_STUB(accepted), PROMOTE_OIDC_DEV_BYPASS,
                      EMBEDDER_STUB all true → no AWS vars required → listen :3000 → /health 200

### Smoke run

    pnpm smoke ── GET  /health ───────────────────────────────▶ {status:"ok"}
               ── POST /mcp initialize ───────────────────────▶ serverInfo.name == "gmemo"
               ── POST /mcp tools/call recall {query:"pnpm"} ─▶ results ≥ 1 (seeded constraint)
               ── POST /mcp tools/call remember {add,…runId} ─▶ staging_item in open session (main)
               ── POST /mcp tools/call list_staged ───────────▶ items ∋ remembered id
               ── POST /promote {repo, source_branch:"main"} ─▶ DevOidcAuthenticator principal
                        │ repo == principal.repository == "crombie-llc/gmemo-demo"
                        │ findRepoByGithubSlug → seeded repo (remote .../crombie-llc/gmemo-demo.git)
                        │ authorizePromote → seeded machine_credential (service_agent)
                        ▼ judge stub "accepted" → applied ≥ 1, session → promoted
               ── POST /promote (again) ──────────────────────▶ no open session → {status:"no_op", applied:0}

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `DEV_PROMOTE_PRINCIPAL.repository` = `crombie-llc/gmemo-demo` | const | `src/auth/devOidcAuthenticator.ts` | `migrations/seed.dev.sql` (machine_credential.principal_name, repo remote slug), `scripts/smoke.ts` (`/promote` body `repo`), `tests/auth/oidc.test.ts` |
| `DEV_PRINCIPAL.scopes` = `['gmemo.memory/read']` | const | `src/auth/devAuthenticator.ts` | `tests/auth/devAuthenticator.test.ts` |
| MCP `serverInfo.name` = `gmemo` | value | `src/mcp/server.ts` | `scripts/smoke.ts`, `tests/mcp/registration.test.ts` |
| Seed repo remote `https://github.com/crombie-llc/gmemo-demo.git` | value | `migrations/seed.dev.sql` | `scripts/smoke.ts` (`X-Git-Remote`), `docker-compose.yml` comment, `.env.dev.example` comment, `README.md`, `DEVELOPMENT.md` |
| `POST /promote` body + `PromoteOutcome` | endpoint | `src/http/promote.ts`, `src/promote/promoteService.ts` | `scripts/smoke.ts` |
| Workflow vars `GMEMO_OIDC_AUDIENCE`, `GMEMO_PROMOTE_URL` | CI var | `.github/workflows/promote.yml` | `terraform/README.md`, `openspec/backlog.md` (repo variables are renamed out-of-band) |

## Rename map (P4)

| From | To | Where |
|---|---|---|
| `lpms-cloud` (package name, serverInfo name, boot log) | `gmemo` | `package.json:2`, `src/mcp/server.ts:15`, `src/index.ts:218` |
| `LPMS Cloud MCP Facade — read-tool scaffold` | `gmemo MCP facade` | `package.json:4` |
| image `lpms-cloud:dev` | `gmemo:dev` | `docker-compose.yml` |
| db user/pass/name `lpms` | `gmemo` / `gmemo` / `gmemo` | `docker-compose.yml`, `.env.dev.example` |
| `lpms.memory/read` | `gmemo.memory/read` | `src/auth/devAuthenticator.ts:22`, test |
| `crombie-dev/lpms-cloud` | `crombie-llc/gmemo-demo` | devOidcAuthenticator, seed, tests, README, terraform/README examples |
| seed project `('lpms-cloud','LPMS Cloud (local dev)')` | `('gmemo','gmemo (local dev)')` | `migrations/seed.dev.sql:15` |
| seed repo slug `lpms-cloud` | `gmemo-demo` | `migrations/seed.dev.sql:24` |
| `LPMS_OIDC_AUDIENCE` / `LPMS_PROMOTE_URL` / `name: LPMS Promote` | `GMEMO_OIDC_AUDIENCE` / `GMEMO_PROMOTE_URL` / `name: gmemo Promote` | `.github/workflows/promote.yml`, `terraform/README.md:475-476`, `openspec/backlog.md:63` |
| `lpms-pilot-*`, `/lpms/pilot/app`, `lpms/pilot/app`, `lpms_master`, db `lpms`, `Project="lpms"` | `gmemo-pilot-*`, `/gmemo/pilot/app`, `gmemo/pilot/app`, `gmemo_master`, `gmemo`, `Project="gmemo"` | terraform/**, `.github/workflows/deploy.yml:46-49`, `docs/10`, terraform READMEs |
| `docs/artefactos/lpms_schema_v2.sql` | `docs/artefactos/gmemo_schema_v2.sql` | file + refs in migrations 0001–0004, `src/judge/bedrockJudge.ts:42`, `DEVELOPMENT.md`, `docs/06`, `openspec/config.yaml:25,108`, `openspec/project-map.yaml:77,118` |
| `docs/artefactos/lpms_facade_contract_v1.md` | `docs/artefactos/gmemo_facade_contract_v1.md` | file + refs in `src/contracts/{tools,memory}.ts`, `DEVELOPMENT.md`, `docs/06`, `openspec/config.yaml:107`, `openspec/project-map.yaml:31,116` |
| `docs/LPMS_Cloud_Diseno_v0.6.docx` | `docs/gmemo_Cloud_Diseno_v0.6.docx` | file only (no references outside the archive) |
| `@lpms/web` | `@gmemo/web` | `packages/web/README.md` |
| `aud: 'lpms'` (fixture) | `aud: 'gmemo'` | `tests/auth/oidc.test.ts:43` |
| "LPMS Cloud" / "LPMS" as **product** in prose | "gmemo" | README title, DEVELOPMENT, `docs/05:5`, `docs/06`, `docs/10`, artefact headers, `openspec/{config,backlog,project-map}`, terraform READMEs, `promote.yml` comments |

### KEEP (must not be renamed)

- Category (d), the orchestrator memory tool: `openspec/config.yaml:95` (`cache_store: lpms`), `docs/07-captura-dev-y-skill.md:39,43` (`lpms-convention`).
- Predecessor wording (local SQLite LPMS): `docs/01-vision-y-capas.md:4,13,28,34`, `openspec/config.yaml:10`, `README.md:3`. The README:3 sentence keeps "la evolución de LPMS (memoria local por dev)", and only the product name before it changes to gmemo.
- Everything under `openspec/changes/archive/**` (sanitize only), `.claude/**`, `.mcp.json` (its `lpms-local` server and `crombie-dev/lpms-cloud` header are local tooling, gitignored and untouched; after C0 the local MCP header no longer matches the seed, which is acceptable because it targets the orchestrator's own server, not this stack).
- `tests/config/promoteConfig.test.ts:147` (`https://github.com/crombie-dev` is a neutral audience fixture, not the dev slug).

## Placeholder table (P2)

Values are described, never quoted. Implementers locate them with `.sanitize-patterns` and exploration §5 line numbers.

| Sensitive value (description) | Placeholder | Locations |
|---|---|---|
| AWS account ID (12 digits) | `<AWS_ACCOUNT_ID>` | `docs/10:8,84,86,87`, `.github/workflows/deploy.yml:25`, `terraform/cicd/README.md:48`, archive `terraform-infra/design.md`; `terraform/cicd/variables.tf:10` → **remove default** |
| ARN embedding the literal account | `arn:aws:<svc>::<AWS_ACCOUNT_ID>:…` | `.github/workflows/deploy.yml:25`, archive files that match the ARN pattern |
| Operator public IP | `<OPERATOR_IP>/32` | `docs/10:60` |
| Route 53 hosted zone ID | `<HOSTED_ZONE_ID>` | `docs/10:9` |
| Personal work emails | `<ADMIN_EMAIL>` | `docs/10:62` (both emails → one `<ADMIN_EMAIL>` list entry) |
| Company email domain in examples/allowlists | `@<COMPANY_DOMAIN>` (e.g. `you@<COMPANY_DOMAIN>`) | `openspec/config.yaml:28`, `docs/03:9`, `docs/02:40` if the gate hits, `terraform/README.md:249,276,321`, archive `auth-two-gate/{exploration,design}.md`, archive `terraform-infra/design.md` |
| Live pilot FQDN | `<DOMAIN>` | `docs/10:9,61,75,144`, exploration line 48 |
| Bare company domain | `<COMPANY_DOMAIN>` | `docs/10:75` |
| Live GitHub repo slug / remote | `<GITHUB_ORG>/<REPO>` / `https://github.com/<GITHUB_ORG>/<REPO>.git` | `docs/10:10,146,166,179`, `terraform/cicd/README.md:18,49,62,71,85,86,132`, `src/db/provision.ts:38`, exploration line 43; `terraform/cicd/variables.tf:21` → **remove default** |
| Live project name (the third product name) | `<REPO>` | `docs/10:10` |
| Terraform state bucket | `<TFSTATE_BUCKET>` | `terraform/{cicd,envs/pilot}/backend.hcl`, `docs/10:20,26,56`, `terraform/cicd/README.md:21` |
| Terraform lock table | `<TFLOCK_TABLE>` | `terraform/{cicd,envs/pilot}/backend.hcl`, `docs/10:21,26,57` |
| Live OIDC role name | `<OIDC_ROLE_NAME>` | `docs/10:177`, `.github/workflows/deploy.yml:25` |
| Personal names in prose | role noun ("el operador", "el autor") | `docs/10:200`, `docs/07:23` |

### KEEP (sanitization)

`terraform/cicd/main.tf:16-22` and `terraform/bootstrap/main.tf:82-83` (ARNs built from `${var.account_id}`/data sources); the AWS-managed policy ARN (`arn:aws:iam::aws:policy/…`); `terraform/envs/pilot/pilot.tfvars.example` (already sanitized; only its `lpms-pilot.example.com` is renamed in P4); RFC 5737 / RFC 1918 ranges; 12-digit UUID fragments in tests (false positives); the public org `crombie-llc` inside the new demo slug `crombie-llc/gmemo-demo` (D2).

### Binary scan (P3)

`tar -xf docs/LPMS_Cloud_Diseno_v0.6.docx -C <scratch>/docx` (Windows bsdtar reads zip) and the same for `docs/artefactos/Crombie_Shared_Memory_Comparison.xlsx`, then `rg -f .sanitize-patterns <scratch>`. If there is any hit: **do not edit the binary**. Record the file and the match category (no value) in apply-progress, then stop for Diego before P3's commit. PNGs: manual review by Diego (out of scope).

## Runtime artefacts

### `docker-compose.yml` (final)

- `db`: `image: pgvector/pgvector:pg16`; `POSTGRES_USER/PASSWORD/DB: gmemo`; healthcheck `pg_isready -U gmemo -d gmemo`; volume `pgdata`; port `5432:5432`.
- `migrate`: `build: .`, `image: gmemo:dev`, same command; env:
  - `DATABASE_URL: "postgres://gmemo:gmemo@db:5432/gmemo"`
  - `NODE_ENV: development`
- `app`: `build: .`, `image: gmemo:dev`; env:
  - `DATABASE_URL: "postgres://gmemo:gmemo@db:5432/gmemo"`
  - `NODE_ENV: development`
  - `AUTH_DEV_BYPASS: "true"`
  - `JUDGE_STUB: "true"`
  - `JUDGE_STUB_VERDICT: "accepted"` (new: the seeded item and smoke item actually promote)
  - `PROMOTE_OIDC_DEV_BYPASS: "true"`
  - `EMBEDDER_STUB: "true"` (new: removes the Bedrock/AWS_REGION requirement)
  - `PORT: "3000"`, `HOST: "0.0.0.0"`, `LOG_LEVEL: debug`
  - Rate limiting is left at defaults (ON). The smoke test makes 2 `/promote` calls (limit 10/min) and 4 MCP calls (limit 120/min).
- Comment above `app` updated to `X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git`. Still no `env_file`, no interpolation.

### `.env.dev.example` (reconciled, for `pnpm dev` on the host against the compose db)

`DATABASE_URL=postgres://gmemo:gmemo@localhost:5432/gmemo`, `AUTH_DEV_BYPASS=true`, `NODE_ENV=development`, `PORT=3000`, `JUDGE_STUB=true`, `JUDGE_STUB_VERDICT=accepted`, `PROMOTE_OIDC_DEV_BYPASS=true`, **`EMBEDDER_STUB=true`** (new, with the same "forbidden in production" comment), and the X-Git-Remote comment updated. Header note: compose does not read this file.

### `Dockerfile` (builder stage only changes)

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build            # root script only → tsc over src/
RUN pnpm prune --prod
```

The runtime stage is unchanged: it copies only root `node_modules`, `dist`, `package.json` and `migrations`, keeps the RDS CA download (the build needs internet) and runs `USER node`.

### `.dockerignore` additions

```
packages/**
!packages/web/package.json
terraform
.github
scripts
.claude
.claude.json
.mcp.json
entrevistas
prompt.md
PROMPT-demo-entrega4.md
.sanitize-patterns
```

`pnpm-workspace.yaml` must **not** be ignored.

### `package.json`

`name: "gmemo"`, new description, new script `"smoke": "tsx scripts/smoke.ts"`, and `"lint": "eslint src tests scripts"` (the smoke script gets linted; `tsc` stays scoped to `src` so `dist/` is unchanged). No dependency changes.

## Smoke script contract (`scripts/smoke.ts`)

- **Run**: `pnpm smoke` against a running stack. **Env**: `BASE_URL` (default `http://localhost:3000`, trailing slash stripped). Constants: `REMOTE = https://github.com/crombie-llc/gmemo-demo.git`, `REPO = crombie-llc/gmemo-demo`, `BRANCH = main`.
- **MCP request headers**: `Content-Type: application/json`, `Accept: application/json, text/event-stream` (the SDK transport rejects requests that lack both), `X-Git-Remote: REMOTE`, `X-Git-Branch: main`. After `initialize`, every call also sends `MCP-Protocol-Version: <result.protocolVersion>`. Each call is an independent POST (stateless server). JSON-RPC ids increase per call.
- **Response parsing**: if `Content-Type` includes `text/event-stream`, read the body as text, split events on blank lines, join the `data:` lines of each event, `JSON.parse`, and pick the message whose `id` equals the request id. Otherwise `JSON.parse` the body. A JSON-RPC `error` fails the step. For `tools/call`, a `result.isError === true` fails the step. The payload is `JSON.parse(result.content[0].text)`.
- **Timeouts**: `AbortSignal.timeout(10_000)` per request.
- **Steps (fail-fast, in order)**:

| # | Step | Request | Pass condition |
|---|---|---|---|
| 1 | health | `GET /health` | 200 and `status === "ok"` |
| 2 | initialize | `initialize` {protocolVersion: `2025-03-26`, capabilities: {}, clientInfo: {name: "gmemo-smoke", version: "0"}} | `result.serverInfo.name === "gmemo"` |
| 3 | recall | `tools/call` `recall` {query: "pnpm"} | `results.length >= 1` |
| 4 | remember | `tools/call` `remember` {op: "add", type: "gotcha", title: `Smoke ${runId}`, summary, body containing runId} | `typeof id === "string"` and `state` ∈ {pending, uncertain} |
| 5 | list_staged | `tools/call` `list_staged` {} | `items` contains the id from step 4 |
| 6 | promote | `POST /promote` `{repo: REPO, source_branch: "main"}`, header `Authorization: Bearer dev-smoke` | 200, `status` ∈ {promoted, partially_promoted}, `applied >= 1` |
| 7 | promote idempotent | the same request again | 200, `status === "no_op"`, `applied === 0` |

`runId = Date.now().toString(36)` keeps step 4's content hash unique, so the script can be re-run without `down -v` (remember opens a new session after the previous one was promoted). The implementer must confirm that `remember` with type `gotcha` needs no mandatory `fields` (see `src/mcp/tools/fieldsPolicy`/schemas). If it does, supply the minimal valid `fields`.
- **Output**: one line per step, `PASS <step>` or `FAIL <step>: <reason>`. Never print response bodies beyond the failing field (no secrets exist in dev, but keep the habit).
- **Exit codes**: `0` all steps pass. `1` a check failed (unexpected status, shape or value). `2` the stack is unreachable (fetch network error or timeout on step 1), with the hint "is `docker compose up` running?". Every caught error is reported. Nothing is swallowed.

## Spec consolidation (P9)

| Archived spec | → `openspec/specs/{domain}/spec.md` |
|---|---|
| `archive/scaffold-runtime-mcp-facade/specs/spec.md` | `mcp-facade` |
| `archive/auth-two-gate/specs/spec.md` | `auth` |
| `archive/data-model/specs/spec.md` | `memory-read` |
| `archive/write-path/specs/write-path.md` | `staging` |
| `archive/hybrid-search/specs/hybrid-search.md` | `hybrid-search` |
| `archive/promotion-pipeline/specs/promotion-pipeline.md` | `promotion` |
| `archive/promotion-schema-gaps/specs/promotion-schema-gaps.md` | `promotion` |
| `archive/promote-oidc/specs/oidc.md` | `promotion` (it refines promotion-pipeline's "OIDC auth for /promote"; one home avoids a split requirement) |
| `archive/real-bedrock-clients/specs/bedrock-clients.md` | `bedrock-clients` |
| `archive/security-hardening/specs/hardening.md` | `http-security` |
| `archive/terraform-infra/specs/infra.md` | `infrastructure` |
| `archive/dev-harness/specs/spec.md` | `dev-harness` |
| this change: `demo-baseline/specs/repository-hygiene/spec.md` | `repository-hygiene` (created by C0 **archive** sync, not during apply) |

Rules: cross-cutting prod-guard requirements stay in the spec of the seam they guard (auth bypass → `auth`, judge/OIDC bypass → `promotion`, embedder stub → `hybrid-search`, rate limit → `http-security`), and `dev-harness` links to them rather than duplicating them. The `infrastructure` spec uses `gmemo-pilot-*` names and placeholders. **Later changes (C1+)** write delta specs (`ADDED/MODIFIED/REMOVED Requirements`) against these domain names, and sdd-archive merges them. New capabilities get a new domain folder.

> **Note for the orchestrator**: the compose/workspace/smoke behavior of C0 has no delta spec (only `repository-hygiene` exists). Recommendation: add a small `dev-harness` delta (bootable compose without AWS, `pnpm smoke` contract) so that P9's `dev-harness` spec reflects the final state. Otherwise those requirements only exist in this design.

## File Changes

Each table is an area. Areas are disjoint, so tasks in different areas of the same phase can be batched in parallel. The Phase column in descriptions tells which phase touches the file (S = P2 sanitize, R = P4 rename).

### Area A — root / runtime (P1, P6, P8)

| File | Action | Description |
|------|--------|-------------|
| `.gitignore` | Modify | P1: add `.claude/`, `.claude.json`, `.mcp.json`, `entrevistas/`, `prompt.md`, `PROMPT-demo-entrega4.md`, `.sanitize-patterns`; remove the Prisma block (`packages/server/src/generated/`), keeping `!.env.dev.example` right after the `.env.*` rules; drop duplicate Node block |
| `.sanitize-patterns` | Create | P1: local-only (gitignored) gate patterns, one regex per line |
| `pnpm-workspace.yaml` | Create | P6: `packages: ['packages/*']` |
| `packages/web/package.json` | Create | P6: `@gmemo/web`, `private: true`, no deps |
| `packages/web/README.md` | Modify | R: `@lpms/web` → `@gmemo/web` |
| `package.json` | Modify | P6: name `gmemo`, description, `smoke` script, lint includes `scripts` |
| `pnpm-lock.yaml` | Modify | P6: regenerated by `pnpm install` (human/network); adds `packages/web` importer |
| `Dockerfile` | Modify | P6: copy workspace manifests before frozen install |
| `.dockerignore` | Modify | P6: exclusions listed above |
| `docker-compose.yml` | Modify | P6 (+R): pgvector image, gmemo creds/image, `EMBEDDER_STUB`, `JUDGE_STUB_VERDICT`, comment |
| `.env.dev.example` | Modify | P6 (+R): gmemo URL, `EMBEDDER_STUB=true`, remote comment |
| `DEVELOPMENT.md` | Modify | P8: full rewrite (pnpm, Node 22, compose up/down -v, scripts that exist, `.env.dev.example` for host dev, smoke test, the build needs internet for the RDS CA, workspace note `pnpm add -w`); no Prisma/npm |
| `README.md` | Modify | P8 (+R): title → gmemo, keep line 3 predecessor wording, curl examples use the new remote, env list matches `src/config/index.ts` (incl. EMBEDDER_STUB, RATE_LIMIT_*, SEMANTIC_FALLBACK_*), links to DEVELOPMENT + smoke |

### Area B — src + tests (P2 provision only, P4)

| File | Action | Description |
|------|--------|-------------|
| `tests/auth/devAuthenticator.test.ts` | Modify | R (first, red): line 41 → `['gmemo.memory/read']` |
| `tests/auth/oidc.test.ts` | Modify | R (first, red): line 8 comment, line 43 `aud: 'gmemo'`, line 69 → `'crombie-llc/gmemo-demo'` |
| `tests/mcp/registration.test.ts` | Modify | R (first, red): assert `client.getServerVersion()?.name === 'gmemo'` |
| `tests/config/rateLimitGuard.test.ts` | Create | Guard test (see Test Strategy) |
| `src/mcp/server.ts` | Modify | R: serverInfo name `gmemo` |
| `src/index.ts` | Modify | R: boot log `gmemo listening on …` |
| `src/auth/devAuthenticator.ts` | Modify | R: scope `gmemo.memory/read` |
| `src/auth/devOidcAuthenticator.ts` | Modify | R: lines 23, 26 → `crombie-llc/gmemo-demo` |
| `src/contracts/tools.ts` | Modify | R: header ref `gmemo_facade_contract_v1.md` |
| `src/contracts/memory.ts` | Modify | R: header ref `gmemo_facade_contract_v1.md` |
| `src/judge/bedrockJudge.ts` | Modify | R: line 42 ref `gmemo_schema_v2.sql` |
| `src/db/provision.ts` | Modify | S: line 38 example → `https://github.com/<GITHUB_ORG>/<REPO>.git` |

### Area C — migrations (P4)

| File | Action | Description |
|------|--------|-------------|
| `migrations/0001_auth_tenancy.sql` | Modify | R: header ref `gmemo_schema_v2.sql` (comment only; migration ledger keys on filename, not checksum, so already-applied DBs are unaffected) |
| `migrations/0002_memory.sql` | Modify | R: header ref |
| `migrations/0003_staging.sql` | Modify | R: header ref |
| `migrations/0004_promotion_gaps.sql` | Modify | R: header ref |
| `migrations/seed.dev.sql` | Modify | R: project `gmemo`/`gmemo (local dev)`, remote `https://github.com/crombie-llc/gmemo-demo.git`, repo slug `gmemo-demo`, machine_credential principal + comment line 74; Decision 3: membership `contributor` |

### Area D — terraform (P2, P4)

| File | Action | Description |
|------|--------|-------------|
| `terraform/README.md` | Modify | S: emails → `you@<COMPANY_DOMAIN>`; R: all `lpms-*`, `LPMS_*` vars, slug examples; add the D1 replacement warning at the top |
| `terraform/cicd/README.md` | Modify | S: account, repo slug, bucket placeholders; R: `gmemo-pilot-*` |
| `terraform/cicd/variables.tf` | Modify | S: delete the `default` of `account_id` and `github_repo`; R: `gmemo-pilot-*` defaults (lines 33–63) |
| `terraform/cicd/backend.hcl` | Modify | S: `<TFSTATE_BUCKET>`, `<TFLOCK_TABLE>` + fill-in comment |
| `terraform/cicd/versions.tf` | Modify | R: tag `Project = "gmemo"` |
| `terraform/envs/pilot/backend.hcl` | Modify | S: `<TFSTATE_BUCKET>`, `<TFLOCK_TABLE>` + fill-in comment |
| `terraform/envs/pilot/versions.tf` | Modify | R: tag `Project = "gmemo"` |
| `terraform/envs/pilot/variables.tf` | Modify | R: example FQDN `gmemo-pilot.yourdomain.dev` |
| `terraform/envs/pilot/pilot.tfvars.example` | Modify | R: `gmemo-pilot.example.com` |
| `terraform/bootstrap/versions.tf` | Modify | R: tag `Project = "gmemo"` |
| `terraform/bootstrap/variables.tf` | Modify | R: example bucket + default lock table `gmemo-pilot-tflock` |
| `terraform/modules/service/main.tf` | Modify | R: all `lpms-pilot-*` names, log group `/gmemo/pilot/app` |
| `terraform/modules/network/main.tf` | Modify | R: `gmemo-pilot-*` names/tags |
| `terraform/modules/data/main.tf` | Modify | R: subnet group, param group, identifier, `db_name = "gmemo"`, `username = "gmemo_master"`, final snapshot, tags, DATABASE_URL template |
| `terraform/modules/data/variables.tf` | Modify | R: secret name default `gmemo/pilot/app` |
| `terraform/modules/cognito/main.tf` | Modify | R: tag name |
| `terraform/modules/cognito/variables.tf` | Modify | R: pool/client name defaults |
| `terraform/modules/dns-tls/main.tf` | Modify | R: tag names |
| `terraform/modules/dns-tls/variables.tf` | Modify | R: example FQDN |

### Area E — workflows (P2, P4)

| File | Action | Description |
|------|--------|-------------|
| `.github/workflows/deploy.yml` | Modify | S: line 25 ARN comment → `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<OIDC_ROLE_NAME>`; R: env names `gmemo-pilot-*` (lines 46–49) |
| `.github/workflows/promote.yml` | Modify | R: `GMEMO_OIDC_AUDIENCE`, `GMEMO_PROMOTE_URL`, workflow name, comments |

### Area F — docs (P2, P4)

| File | Action | Description |
|------|--------|-------------|
| `docs/10-deploy-pilot-aws.md` | Modify | S: every placeholder-table row for docs/10, personal names → role; R: `gmemo-pilot-*`, `/gmemo/pilot/app`, product name |
| `docs/03-auth-identidad-rbac.md` | Modify | S: allowlist domain → `@<COMPANY_DOMAIN>` |
| `docs/02-hosting-infra-aws.md` | Modify | S: line 40 company email domain if the gate hits (exploration lists it; current grep did not, so verify) |
| `docs/07-captura-dev-y-skill.md` | Modify | S: line 23 personal name → role. Lines 39/43 are KEEP |
| `docs/05-tipos-memoria-y-busqueda.md` | Modify | R: line 5 product "LPMS" → "gmemo" |
| `docs/06-contrato-facade-y-datos.md` | Modify | R: artefact refs + product name |
| `docs/artefactos/lpms_schema_v2.sql` | Rename | → `docs/artefactos/gmemo_schema_v2.sql`; R: header line 2 |
| `docs/artefactos/gmemo_schema_v2.sql` | Create | (rename target of the above) |
| `docs/artefactos/lpms_facade_contract_v1.md` | Rename | → `docs/artefactos/gmemo_facade_contract_v1.md`; R: title |
| `docs/artefactos/gmemo_facade_contract_v1.md` | Create | (rename target of the above) |
| `docs/LPMS_Cloud_Diseno_v0.6.docx` | Rename | → `docs/gmemo_Cloud_Diseno_v0.6.docx` (binary untouched; XML scanned in P3) |
| `docs/gmemo_Cloud_Diseno_v0.6.docx` | Create | (rename target of the above) |

`docs/01-vision-y-capas.md` is intentionally **not** changed (KEEP).

### Area G — openspec (P2, P4)

| File | Action | Description |
|------|--------|-------------|
| `openspec/config.yaml` | Modify | S: line 28 → `@<COMPANY_DOMAIN>`; R: lines 6–7 name/display_name, 25/107/108 artefact refs. Lines 10 and 95 are KEEP |
| `openspec/backlog.md` | Modify | R: title, line 63 `GMEMO_OIDC_AUDIENCE`; add a "Rename note: LPMS Cloud → gmemo (C0); archived changes keep the old name" |
| `openspec/project-map.yaml` | Modify | R: `project: gmemo`, artefact paths; add `pnpm-workspace.yaml`, `packages/web`, `scripts/smoke.ts`, `tests/config/rateLimitGuard.test.ts`, `pnpm smoke`; remove any `packages/server`/Prisma mention |
| `openspec/changes/archive/auth-two-gate/exploration.md` | Modify | S only (company email domain) |
| `openspec/changes/archive/auth-two-gate/design.md` | Modify | S only |
| `openspec/changes/archive/terraform-infra/design.md` | Modify | S only (account ID / ARN) |
| `openspec/changes/demo-baseline/proposal.md` | Modify | S: replace the literal gate regex with a reference to `.sanitize-patterns` (Decision 1) |
| `openspec/changes/demo-baseline/exploration.md` | Modify | S: lines 43, 48, 52 → placeholders |
| `openspec/changes/demo-baseline/specs/repository-hygiene/spec.md` | Modify | S: scenario "Sanitization grep is empty" references `.sanitize-patterns` |

### Area H — dead scaffolding (P5)

| File | Action | Description |
|------|--------|-------------|
| `packages/server/package.json` | Delete | Dead Prisma scaffold, not in lockfile, breaks the workspace frozen install |
| `packages/server/tsconfig.json` | Delete | idem |
| `packages/server/prisma/schema.prisma` | Delete | idem |
| `packages/server/src/env.ts` | Delete | idem |
| `packages/server/src/index.ts` | Delete | idem |
| `packages/server/src/mcp/tools.ts` | Delete | idem |
| `packages/infra/README.md` | Delete | README-only placeholder (infra lives in `terraform/`) |
| `infra/docker-compose.yml` | Delete | Dead duplicate of the root compose db |
| `tsconfig.base.json` | Delete | Only consumer was `packages/server/tsconfig.json` |

### Area I — smoke (P7)

| File | Action | Description |
|------|--------|-------------|
| `scripts/smoke.ts` | Create | Smoke test per the contract above |

### Area J — specs baseline (P9)

| File | Action | Description |
|------|--------|-------------|
| `openspec/specs/mcp-facade/spec.md` | Create | From scaffold-runtime-mcp-facade |
| `openspec/specs/auth/spec.md` | Create | From auth-two-gate |
| `openspec/specs/memory-read/spec.md` | Create | From data-model |
| `openspec/specs/staging/spec.md` | Create | From write-path |
| `openspec/specs/hybrid-search/spec.md` | Create | From hybrid-search |
| `openspec/specs/promotion/spec.md` | Create | From promotion-pipeline + promotion-schema-gaps + promote-oidc |
| `openspec/specs/bedrock-clients/spec.md` | Create | From real-bedrock-clients |
| `openspec/specs/http-security/spec.md` | Create | From security-hardening |
| `openspec/specs/infrastructure/spec.md` | Create | From terraform-infra (gmemo names, placeholders) |
| `openspec/specs/dev-harness/spec.md` | Create | From dev-harness (pgvector image, EMBEDDER_STUB, gmemo slug) |
| `openspec/specs/.gitkeep` | Delete | Directory now has content (only if it exists) |

## New Modules

None. (`scripts/` holds one file; `packages/web/` holds only a manifest and README.)

## Test Strategy

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| `tests/auth/devAuthenticator.test.ts` | unit | `DEV_PRINCIPAL.scopes` equals `['gmemo.memory/read']` | TDD: edit first (red), then `src/auth/devAuthenticator.ts` (green) |
| `tests/auth/oidc.test.ts` | unit | `DEV_PROMOTE_PRINCIPAL.repository === 'crombie-llc/gmemo-demo'`; fixture `aud: 'gmemo'` | TDD red→green with `src/auth/devOidcAuthenticator.ts` |
| `tests/mcp/registration.test.ts` | unit (InMemoryTransport) | after connect, `client.getServerVersion()?.name === 'gmemo'` (spec: "MCP server identity") | TDD red→green with `src/mcp/server.ts`. No existing test asserts the old name |
| `tests/config/rateLimitGuard.test.ts` | unit | (a) `RATE_LIMIT_ENABLED=false` + `NODE_ENV=production` + an otherwise **complete valid prod env** (DATABASE_URL, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID_ALLOWLIST, COGNITO_REQUIRED_SCOPE, BEDROCK_MODEL_ID, BEDROCK_EMBEDDING_MODEL_ID, AWS_REGION, GITHUB_OIDC_AUDIENCE) → `process.exit(1)` and the `console.error` payload mentions `RATE_LIMIT_ENABLED` (proves *this* guard fired, not a missing var); (b) the same env with `RATE_LIMIT_ENABLED` unset → loads, `RATE_LIMIT_ENABLED === true`; (c) `RATE_LIMIT_ENABLED=false` + development with all stubs → loads, value `false` | Pattern copied from `prodGuard.test.ts`. The guard already exists (`src/config/index.ts:193`), so this is a characterization test. To prove it is not vacuous, the implementer temporarily disables the guard, confirms (a) fails, then restores it, and records this in apply-progress |
| Seed / compose / Dockerfile | e2e (manual, human) | `docker compose down -v && docker compose up --build`: db, migrate, app healthy from scratch | Needs Docker Desktop + internet |
| `scripts/smoke.ts` | e2e | 7 steps above; exit 0; re-run without `down -v` also exits 0 | Run by a human against compose. Not part of `pnpm test` (it needs a live stack) |
| Repo hygiene gates | scripted checks | `rg -f .sanitize-patterns` empty; docx/xlsx XML scan empty or reported; `rg -i lpms -g '!openspec/changes/archive/**'` only KEEP hits; `rg 'lpms_schema_v2\|lpms_facade_contract_v1' -g '!openspec/changes/archive/**'` empty; `git ls-files` excludes ignored paths | Run in P3 and P10 |
| Full suite | regression | `pnpm test -- --run`, `pnpm lint`, `pnpm build` green | Integration tests (`tests/db/*`, `tests/integration/*`) don't load the seed, so Decision 3 doesn't affect them. No test asserts seed values |
