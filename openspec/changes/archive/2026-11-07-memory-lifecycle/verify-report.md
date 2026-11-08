# Verify Report: memory-lifecycle

## Round 1

**Round 1 Verdict: PASS**

Tasks: 8/8 complete (+X1 reserved-branch guard on list/discard).

## Spec Compliance (crombie-reviewer)
HU-12.1 sweep + exclusion, idempotent sweep, job + script, HU-12.4 outcome never expires, apply sets `revalidate_at` (add/amend/supersede, dedup and deprecate unchanged), HU-12.2 confirm, HU-12.3 retire, HU-11.4 retire-by-pr with project isolation, uniform 404 access, memory-read per-status exclusion (unit + DB): COMPLIANT. Confirm-then-recall: PARTIAL (covered indirectly by the exclusion predicate tests).

## Code Review — APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM `src/http/api/memoryRoutes.ts` — audit after commit (consistent with C2; ids logged)
- R1-CR2 LOW reason clamp may split a mask token (CHECK backstop) · R1-CR3 LOW retired ids dropped from the DTO · R1-CR4 LOW seeded demo memories never expire (C8 seed sets deadlines)
- Scanner hit at `src/index.ts:283` verified false positive (token presence check, not a comparison)

## Security Audit — FINDINGS (LOW only)
- R1-SEC1 audit after commit · R1-SEC2 retire-by-pr has no cap (admin only, audited) · R1-SEC3 clamp after mask · R1-SEC4 sweep is platform-wide (jobs router guards) · R1-SEC5 CTE locking semantics safe

## Test / Build / Lint
unit 1347 · DB gate 1586/0 · lint · build · compose · `pnpm smoke` ×3 · API walk (sweep 3 → list → confirm → retire with PII masked / secret 400 → retire-by-pr 3 → repeat 0).

## Deviations from Design (context only)
`revalidationDays` in `PromotionRepositoryOptions`; `API_UPDATE_ACTIONS` name kept; review route helpers reused; ledger cleanup of 0005/0009/0010 in an older suite.

## Strengths ✅
Single write point for `revalidate_at`; atomic CTE lock + revision per row with a real-PG concurrency test; fail-closed reason policy; full permissions matrix.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR1 | MEDIUM | OPEN |
| R1-CR2 | LOW | OPEN |
| R1-CR3 | LOW | OPEN |
| R1-CR4 | LOW | OPEN |
| R1-SEC2 | LOW | OPEN |
