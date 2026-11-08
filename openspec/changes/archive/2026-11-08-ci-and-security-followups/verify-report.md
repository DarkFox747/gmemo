# Verify Report: ci-and-security-followups (C11)

**Verdict: PASS** (2 rounds)

## Round 1
- **Checks (worker):** lint, build OK; full suite with DB 2039/2039 (1739 unit, 300 DB).
- **crombie-reviewer (high):** APPROVE_WITH_COMMENTS — no CRITICAL/HIGH; no post-commit `recordApi` left on writes, no double audit rows, hook always on the txn client. MEDIUM: restore stranded after an audit failure post-claim; missing DB tests (direct amend, restore→quarantine, single audit row). LOW: SQL constant placement, non-null assertions, AWS pattern/range separator mismatch, `pnpm test -- --run` ambiguity in CI.
- **crombie-security (high):** FINDINGS — no CRITICAL/HIGH. MEDIUM: narrow AWS detector + AKIA/bare-secret pair surviving redaction; other `sk-` families (Anthropic, OpenRouter) undetected. LOW: quadratic variable-length lookbehinds, invisible separators outside `\p{Cf}`, restore claim before audit, image tag not digest-pinned, CI test command; pre-existing: `secret_assignment` vs JSON quoting, JWT pattern cost, error handler logging full pg errors.

## Remediation (round 2, tasks 4.1–4.5)
- Wider AWS detector (key-name variants, whitespace separators, aligned range via capture group) + AKIA/ASIA + bare 40-char pair → secret; promotion redacts the whole item for the pair; `isSecretFree` scans texts joined with fields JSON.
- General `\bsk-<kind>-` detector (proj, svcacct, admin, None, ant, or).
- Restore un-claim (`releaseRestoreClaim`, single guarded statement) after pipeline/audit failure — closes backlog E4 #1.
- DB tests: direct amend, restore→quarantine, single audit row, un-claim + retry, committed restore never released.
- Capture-group ranges (no lookbehinds), extra invisible chars stripped, error handler logs name/code only, CI `pnpm exec vitest run`, guards instead of non-null assertions.
- Orchestrator inline check: new detectors linear (literal prefixes, no nested quantifiers).
- Re-run: lint, build, full DB suite **2090/2090**.

## Accepted / deferred
- Service image pinned by tag (throwaway DB); `secret_assignment` JSON quoting and JWT pattern cost (pre-existing) → backlog.
