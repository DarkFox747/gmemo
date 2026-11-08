# Verify Report: feature-branch-promotion

**Verdict: PASS** (2 rounds)

## Round 1
- **Tests/build (crombie-worker, apply run):** lint OK, build OK, 1947/1947 tests (121 files, DB included), `pnpm demo` exit 0 (twice), `pnpm smoke` exit 0 after `docker compose down -v && up --build`.
- **crombie-reviewer:** PASS WITH WARNINGS. No CRITICAL/HIGH. MEDIUM: no server-side PR verification (documented trust boundary, kept as follow-up); silent zero-or-many PR fallback in the workflow. LOW: formatting noise, CRLF in the integration test, weak `not.toContain` assertion.
- **crombie-security:** FINDINGS. No CRITICAL/HIGH. **M1**: principal did not bind workflow/event — any default-branch workflow (`workflow_dispatch`, `schedule`, `pull_request_target`, other files) could promote any feature session. LOW: L1 no `merge_commit_sha` check; L2 silent fallback; L3 hard-coded `main` trigger (fails closed); L4 negligible timing; L5 dev stub acceptable dev-only; L6 coverage.

## Remediation (round 2)
- M1 fixed: `PromotePrincipal` carries `eventName` / `jobWorkflowRef` (read after signature verification); merged path requires `event_name = push` and `job_workflow_ref = <repo>/.github/workflows/promote.yml@refs/heads/<default>`; denial matrix tests (4 events × 4 workflow refs × 3 bodies) and claim-extraction tests.
- L1 fixed (`merge_commit_sha == pushed sha`), L2 + reviewer MEDIUM fixed (`::warning::` on every fallback path).
- Orchestrator inline check of the handler diff: guards ordered after repo resolution, all denials opaque `PERMISSION_DENIED`, closed_unmerged untouched.
- Re-run: lint OK, build OK, **1973/1973 tests**, `pnpm demo` exit 0, `pnpm smoke` exit 0.

## Not fixed (accepted, backlog)
- Server-side verification of the PR against the GitHub API (trust boundary = `promote.yml` on push to the default branch).
- closed_unmerged event/workflow binding (pre-existing; limited to the PR's own head branch).
- L3, L4, test-only type debt in pre-existing fakes; `tests/db/promotion.integration.test.ts` was reformatted by prettier (noise, no behaviour change).
