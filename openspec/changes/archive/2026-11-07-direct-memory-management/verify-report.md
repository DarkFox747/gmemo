# Verify Report: direct-memory-management

## Round 1

**Round 1 Verdict: PASS**

Tasks: 8/8 complete at round start.

## Spec Compliance (crombie-reviewer)
Browse and history, preview with no domain rows, direct add of a decision (web_ui, v1, approved_by, recalled, not queued), concurrent edit 409 (pre-check and apply race), credential quarantined with leak, human-approved unreachable from MCP and `/promote`, list defaults: COMPLIANT. Contributor denial PARTIAL (POST only at DB level). Automatic amend clears approved_by: UNTESTED.

## Code Review — APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM denial matrix only on POST · R1-CR2 MEDIUM no information_schema secret scan after direct confirm · R1-CR3 MEDIUM approved_by clearing untested · R1-CR4 MEDIUM committed write then 500 undocumented
- R1-CR5..8 LOW mapper placement · unused actor · project-map note · content-type tests for preview/lifecycle

## Security Audit — FINDINGS
- R1-SEC1 MEDIUM plaintext secret window in staging between insert and quarantine (crash)
- R1-SEC2 MEDIUM a fail-closed judge became apply under human approval
- R1-SEC3..6 LOW invalid cursor date → 500 · model spend on preview · author/approver PII in detail · dedup onto non-active reported as applied
- Humanapproved unreachable by agents; approver not spoofable; no IDOR; no mass assignment; preview persists nothing: verified

## Test / Build / Lint
unit 1534 · DB gate 1805/0 · lint · build · compose · `pnpm smoke` ×2 · API walk

## Round 2 (after task 6.1)

**Round 2 Verdict: PASS**

Evidence: unit 1562 · DB gate 1841/0 (×2) · lint · build · compose · `pnpm smoke` ×2.

| ID | Status |
|----|--------|
| R1-CR1 | RESOLVED |
| R1-CR2 | RESOLVED |
| R1-CR3 | RESOLVED |
| R1-CR4 | RESOLVED (documented) |
| R1-CR5 | OPEN |
| R1-CR6 | OPEN |
| R1-CR7 | RESOLVED |
| R1-CR8 | RESOLVED |
| R1-SEC1 | RESOLVED (web-session-reaper job) |
| R1-SEC2 | RESOLVED (503 evaluation_unavailable) |
| R1-SEC3 | RESOLVED |
| R1-SEC4 | OPEN (generic /api limiter) |
| R1-SEC5 | RESOLVED (display names only) |
| R1-SEC6 | RESOLVED (409 duplicate_inactive) |

## Deviations from Design (context only)
JSON content type enforced on PUT via the shared guard; `toMemoryRefDto` reused; preview DTO types widened; review approve of deprecate no longer sets approved_by; `judge_output_invalid` still applies under human confirm (only the unavailable reasons are refused).

## Strengths ✅
One write path with the human-approved flag set by a single caller and enforced by a source-scan test; preview and confirm share `evaluateCandidate`; microsecond cursor; no credential echoed or logged.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR5 | LOW | OPEN |
| R1-CR6 | LOW | OPEN |
| R1-SEC4 | LOW | OPEN |
