# Verify Report: demo-kit

## Round 1

**Round 1 Verdict: PASS**

Tasks: 8/8 complete at round start.

## Spec Compliance (crombie-reviewer, code + security)
Demo seed, end-to-end script (cycle + final recall expectations), deterministic metrics with disclaimer: COMPLIANT. Instructions and package: PARTIAL (package gate failed open without the local patterns file).

## Review — APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM `scripts/package-demo.sh` sanitization gate fails open when `.sanitize-patterns` is absent
- R1-CR2 MEDIUM no exclusion for key material / other agent tooling dirs
- R1-CR3..8 LOW pipe errors hidden; `-I` skips binaries; seed rename upsert; promote outcome logged (counts only); eval constants duplicate config; nDCG assumes unique ids
- Metric formulas verified against standard definitions; seed uses placeholder credentials only; scripts never print secrets

## Test / Build / Lint
unit 1573 · DB gate 1858/0 · lint · build · compose · `pnpm smoke` (20) · `pnpm demo` ×2 (35 checks) · `pnpm eval` deterministic · `pnpm package:demo` clean.

## Round 2 (after tasks 5.1–5.2)

**Round 2 Verdict: PASS**

Evidence: `pnpm lint`; `pnpm package:demo` exit 0 with patterns (clean, 545 files) and exit 1 without them.

| ID | Status |
|----|--------|
| R1-CR1 | RESOLVED (fail closed; `ALLOW_NO_PATTERNS=1` override) |
| R1-CR2 | RESOLVED |
| R1-CR3..8 | OPEN (LOW) |

## Deviations from Design (context only)
Design skipped; e2e re-proposes drafts on the default branch because `/promote` promotes only that session (documented pilot limitation); restored duplicate expected to re-quarantine; MCP calls run as the fixed dev principal.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR3 | LOW | OPEN |
| R1-CR4 | LOW | OPEN |
| R1-CR7 | LOW | OPEN |
