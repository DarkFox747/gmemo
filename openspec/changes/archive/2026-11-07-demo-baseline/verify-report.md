# Verify Report: demo-baseline

## Round 1

**Round 1 Verdict: PASS**

Tasks: 21/22 complete. Incomplete: 7.2 (orchestrator commit, runs after archive).

---

## Spec Compliance (crombie-reviewer + worker runs)

| Requirement | Scenario | Evidence (code / test) | Result |
|---|---|---|---|
| dev-harness: Compose boots from scratch | Clean boot | `docker-compose.yml` (pgvector, stubs); verified `down -v && up --build`, app healthy | COMPLIANT |
| dev-harness: Compose boots from scratch | Missing stub caught by config | `src/config/index.ts` superRefine; `tests/config/embedderGuards.test.ts` | COMPLIANT |
| dev-harness: Smoke test | Full happy path | `scripts/smoke.ts`; `pnpm smoke` ×2 exit 0 | COMPLIANT |
| dev-harness: Smoke test | Stack down | `scripts/smoke.ts` exit 2 path (code review only) | PARTIAL |
| dev-harness: Workspace layout | Frozen install in Docker | `pnpm-workspace.yaml`, `packages/web/package.json`, `Dockerfile`; image built | COMPLIANT |
| dev-harness: Bypasses impossible in prod | Rate limit cannot be disabled | `tests/config/rateLimitGuard.test.ts` (non-vacuity proven) | COMPLIANT |
| repository-hygiene: No sensitive data | Grep empty / templated ARNs / precedes history / binaries | gate 0 hits; `terraform/cicd/variables.tf`; baseline commit `8359c10` after gate; docx/xlsx XML scanned clean | COMPLIANT |
| repository-hygiene: Tooling untracked | Excluded paths untracked | `.gitignore`; `git ls-files` check | COMPLIANT |
| repository-hygiene: Product is gmemo | MCP identity / package+seed / remaining lpms / artefact refs | `tests/mcp/registration.test.ts`; smoke initialize; KEEP-only grep (except human-owned `.env.dev.example`) | PARTIAL (see R1-CR1) |
| repository-hygiene: No dead scaffolding | Docs match toolchain | deletions; `DEVELOPMENT.md` rewrite | COMPLIANT |
| repository-hygiene: Main specs baseline | Specs consolidated | 10 specs in `openspec/specs/` | COMPLIANT |

Compliance summary: 9/11 compliant, 2 partial (non-blocking).

---

## Code Review (crombie-reviewer)

Reviewer verdict: APPROVE_WITH_COMMENTS

### Critical 🔴 / High 🟠
None.

### Medium 🟡 / Low 🟢
- R1-CR1 MEDIUM `.env.dev.example:7,26` — still holds the old db credentials/port and remote. Agents are permission-denied on `.env*`, so the **human owner** must edit it (target values handed over). Tracked as an OPEN item, outside the C0 commit if it is not fixed in time.
- R1-CR2 LOW — `CLAUDE.md` ignore not in spec → RESOLVED (spec updated).
- R1-CR3 LOW — `prompt.md` ignore → verified present (`.gitignore:64`).
- R1-CR4 LOW `scripts/smoke.ts:132-137` — a non-StepError on the health step reports exit 2. Accepted.
- R1-CR5 LOW — the DB gate was in flight at review time → RESOLVED (task 5.3: 555/555, deterministic).

### Pre-existing debt
- R1-CR6 — FK `ON DELETE SET NULL` on `staging_item.target_memory_id` conflicts with `ck_item_optarget` when a project with amend items is deleted (schema-level; surfaced by 5.3). Follow-up.

---

## Security Audit (crombie-security)

Security verdict: FINDINGS (LOW only)

- R1-SEC1 LOW `docker-compose.yml` ports published on all interfaces → RESOLVED (bound to `127.0.0.1`).
- R1-SEC2 LOW `DEVELOPMENT.md` no "dev-only, do not deploy" warning → RESOLVED.
- R1-SEC3 (orchestrator) `tests/globalSetup.ts` wiped any localhost DB → RESOLVED (also requires db name `gmemo`).
- Pre-existing: unpinned RDS CA hash (`Dockerfile`), AWS `Resource "*"` where AWS cannot scope, `0.0.0.0/0` egress.

---

## Test / Build / Lint (crombie-worker)

- `pnpm test -- --run` → 41 files passed, 7 skipped; 466 passed, 89 skipped (DB suites without `DATABASE_URL`). PASSED
- `DATABASE_URL=…localhost:5433/gmemo pnpm test -- --run` → 555 passed, 0 failed, 0 skipped (twice, reused DB). PASSED
- `pnpm lint` → 0. `pnpm build` → 0.
- `docker compose down -v && up --build -d` → healthy. `pnpm smoke` ×2 → exit 0.

### Area context (area-lint)
Skipped: no area files for the changed paths. `.claude/rules/tests.md` describes a different runner (node:test) and conflicts with the project's real convention (Vitest/pnpm), which wins.

---

## Deviations from Design (context only)
- db host port 5433 (host 5432 taken by a local PostgreSQL); compose ports bound to loopback
- healthcheck uses `127.0.0.1` (busybox resolves `localhost` to `::1`)
- RED not observed for 4.1
- `tests/globalSetup.ts` + serial DB files (task 5.3)
- `CLAUDE.md` added to `.gitignore`
- package-manager hook adjusted at the user's request

---

## Strengths ✅
Gate clean, with patterns kept out of the repo. The smoke test is small, dependency-free and fail-fast. The prod guard tests are non-vacuous. The compose fixes are real root-cause fixes. Web sources are kept out of the server image.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR1 | MEDIUM | OPEN |
| R1-CR4 | LOW | OPEN |
| R1-CR6 | LOW | OPEN |
