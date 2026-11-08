# Verify Report: quarantine-management

## Round 1

**Round 1 Verdict: PASS**

Tasks: 10/10 complete at round start.

## Spec Compliance (crombie-reviewer-high)
All scenarios COMPLIANT: span redaction keeps context, secret never persisted (`tests/db/secretNeverPersisted.integration.test.ts`), author sees own, foreign denied (`tests/http/api/quarantinePermissions.test.ts`), restore applies / re-quarantines / double restore 404 (`tests/db/restore.integration.test.ts`), purge expired, job without token in production (`tests/jobs/jobsRouter.test.ts`).

## Code Review — APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM — a post-claim pipeline failure leaves the entry labelled restored (documented residual)
- R1-CR2 MEDIUM — `jobsEnabled` logic in the composition root is untested
- R1-CR3..7 LOW — staging hash residual undocumented; restore of redacted rows; jobs unthrottled; greedy assignment span (fail-safe); DB errors → 404 (convention)

## Security Audit — FINDINGS
- R1-SEC1 MEDIUM — cross-field PEM header/body left the key body stored
- R1-SEC2 MEDIUM — staging `content_hash` of secret-bearing content kept
- R1-SEC3 MEDIUM — jobs open mode with no explicit opt-in (unset `NODE_ENV`)
- R1-SEC4..8 LOW — OpenAI range tail; restore session collision / reserved prefix; restore of redacted rows; jobs rate limit; `judgeReason` visible to authors
- Pre-existing: detector coverage gaps (`sk-proj-`, `github_pat_`, AWS secret keys); raw-content hash on non-redacted quarantine rows; terminal handler logs full errors

## Test / Build / Lint
unit 1167 · DB gate 1356/0 · lint · build · compose · `pnpm smoke` ×2 (13 steps) · manual API walk (node fetch)

## Round 2 (after task 6.1)

**Round 2 Verdict: PASS**

Evidence: unit 1209 / 197 skipped · DB gate 1406/0 · lint · build · compose · `pnpm smoke` ×2.

| ID | Status |
|----|--------|
| R1-CR1 | OPEN (documented residual) |
| R1-CR2 | RESOLVED (`isJobsEnabled`/`isOpenMode` + tests) |
| R1-CR3 | RESOLVED |
| R1-CR4 | RESOLVED (non-restorable reasons) |
| R1-CR5 | RESOLVED (10/min limiter) |
| R1-CR6 | OPEN (fail-safe) |
| R1-CR7 | OPEN (convention) |
| R1-SEC1 | RESOLVED (PEM anywhere → whole) |
| R1-SEC2 | RESOLVED (`stagingRedactedHash`) |
| R1-SEC3 | RESOLVED (open mode only with `NODE_ENV=development`) |
| R1-SEC4 | RESOLVED |
| R1-SEC5 | RESOLVED (23505 → 404; `restore/`, `web/` reserved for remember) |
| R1-SEC6 | RESOLVED |
| R1-SEC7 | RESOLVED |
| R1-SEC8 | RESOLVED |
| R2-SEC1 | LOW OPEN — `list_staged`/`discard_staged` still accept reserved branches (fixed in C4 task) |

## Deviations from Design (context only)
Purge in `src/quarantine/purge.ts`; shared fixtures; normalized `isSecretFree`; `authorizeProjectMember` denies archived/unknown roles; `internal` excluded from the SPA; restore of redacted rows refused (reverses design test 3); OpenAI range with a lookahead.

## Strengths ✅
A fail-closed never-persisted gate (verify plus whole fallback) proven by a whole-schema scan; classifier and backfill share one fixture table; first-writer-wins restore with a concurrency test; three-layer jobs guard with constant-time comparison.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR1 | MEDIUM | OPEN |
| R1-CR6 | LOW | OPEN |
| R1-CR7 | LOW | OPEN |
| R2-SEC1 | LOW | OPEN |
