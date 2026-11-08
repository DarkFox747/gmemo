# Verify Report: web-api-and-review-queue

## Round 1

**Round 1 Verdict: PASS**

Tasks: 9/10 complete at round start (6.1 manual walk pending; the curl walk was permission-denied for agents).

## Spec Compliance (crombie-reviewer-high)
web-api: 19/19 scenarios; 17 COMPLIANT, 2 PARTIAL (429 without `no-store`; HU-07.3 criterion wording). promotion (HU-04.2): 6/6 COMPLIANT. auth: 4/4 COMPLIANT. http-security: 3/3; 2 COMPLIANT, 1 PARTIAL (429 `no-store`). Evidence: `tests/http/api/*`, `tests/db/review*.integration.test.ts`, `tests/http/promote.test.ts`, `tests/auth/*`, `tests/http/{static,security,app.routes}.test.ts`.

## Code Review — APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM `src/http/app.ts` — 429 lacks `Cache-Control: no-store`
- R1-CR2 MEDIUM — spec says criterion `human_review`; code writes reason prefix (no criterion column until C3)
- R1-CR3 MEDIUM — manual API walk (6.1) not run
- R1-CR4 LOW audit after commit not reconcilable from logs · R1-CR5 LOW loose audit detail types · R1-CR6 LOW no test that Cognito ignores devUser · R1-CR7 LOW case-sensitive NOT_SPA · R1-CR8 LOW reject secret scan before existence check (admin only)
- Pre-existing: `PERSIST_MASKED_SQL` lacks a `reviewed_at` guard

## Security Audit — FINDINGS (LOW only)
- R1-SEC1 dev-only CSRF on approve (text/plain simple POST) · R1-SEC2 dev header can impersonate any enabled user · R1-SEC3 closed_unmerged residual surface (open/sync PR tokens, shared head branch) · R1-SEC4 embedding cost on repeated 409 · R1-SEC5 per-IP limiter vs a future CloudFront · R1-SEC6 audit after commit · R1-SEC7 archived projects writable by admin · R1-SEC8 SVG without CSP / case-sensitive NOT_SPA · R1-SEC9 IdP subject as author fallback (admin only)
- Pre-existing: `NODE_ENV` defaults to development; `express.json` before limiters

## Test / Build / Lint
unit 972 · DB gate 1123/0 · lint 0 · build 0 · compose healthy · `pnpm smoke` ×2

## Round 2 (after task 7.1)

**Round 2 Verdict: PASS**

Evidence: unit 990 / 153 skipped · DB gate 1143/0 · lint · build · compose · `pnpm smoke` ×2 (11 steps incl. me as tl and viewer, queue as tl 200, as viewer 404).

| ID | Status |
|----|--------|
| R1-CR1 | RESOLVED |
| R1-CR2 | RESOLVED (spec reworded) |
| R1-CR3 | RESOLVED (walk automated in smoke) |
| R1-CR4 | RESOLVED (error log with ids) |
| R1-CR5 | RESOLVED |
| R1-CR6 | RESOLVED |
| R1-CR7 | RESOLVED |
| R1-CR8 | OPEN (admin-only, accepted) |
| R1-SEC1 | RESOLVED (JSON content type required on POSTs) |
| R1-SEC2 | OPEN (dev-only; follow-up allowlist) |
| R1-SEC3 | OPEN (accepted residual, documented) |
| R1-SEC4 | OPEN (bounded by limiter) |
| R1-SEC5 | OPEN (future CloudFront) |
| R1-SEC6 | RESOLVED (logged for reconciliation) |
| R1-SEC7 | RESOLVED (`isProjectActive`) |
| R1-SEC8 | RESOLVED |
| R1-SEC9 | OPEN (admin only) |

## Deviations from Design (context only)
Optional→required seam methods; email lookup `lower()` + ambiguity denial; allow-listed audit detail; approve with empty mandatory set and 409 `target_inactive` on type mismatch; disabled user on `/me` → 404; SPA fallback answers extensionless paths; approve/reject require JSON content type.

## Strengths ✅
One write path with transaction-scoped cores; real-DB concurrency tests; three-layer dev-header guard; byte-identical opacity; head_ref-bound closed_unmerged; one error vocabulary.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR8 | LOW | OPEN |
| R1-SEC2 | LOW | OPEN |
| R1-SEC3 | LOW | OPEN |
| R1-SEC4 | LOW | OPEN |
| R1-SEC5 | LOW | OPEN |
| R1-SEC9 | LOW | OPEN |
