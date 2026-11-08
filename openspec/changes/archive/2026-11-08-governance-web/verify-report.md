# Verify Report: governance-web

## Round 1

**Round 1 Verdict: PASS**

Tasks: 8/9 complete; 4.2 (area-context skill under `.claude/`) deferred — denied as self-modification (LOW, tooling only).

## Spec Compliance (crombie-security-high, combined review)
Shell and roles, review queue and detail, quarantine with restore toast and footer, project memory, read-only administration without secrets, safe rendering: COMPLIANT in code. Screen-level scenarios (viewer no-permission, reject reason required, 409 message, preview→confirm, `<script>` rendered as text) are PARTIAL in repo tests (unit tests for client/libs + source-scan XSS test); evidence is the worker's headless Playwright walks at 1440×900 as tl@ and viewer@ (zero console errors, write flows exercised) and the five screenshots.

## Security — CLEAN (LOW only) · Review — APPROVE_WITH_COMMENTS
- R1-SEC1 LOW dev-user selector always rendered (server ignores the header in production)
- R1-SEC2 LOW XSS suppression scan only matches named rule disables
- R1-SEC3 LOW `NON_RESTORABLE` list duplicated client-side (server authoritative)
- R1-CR1..5 LOW fabricated FormEvent, shared dialog error state, PR number safe-integer check, useAsync deps comment, postpone uses location.hash
- Pre-existing: unpinned RDS CA hash; dev DB credentials (loopback only); `img-src data:`

## Test / Build / Lint
`pnpm build && pnpm typecheck:web && pnpm build:web && pnpm test -- --run && pnpm lint` (1647 passed) · DB gate 1935/0 · compose serves `/` with strict CSP · `pnpm smoke` · `pnpm demo` · Playwright walks · `pnpm screenshots` · `pnpm package:demo`.

## Deviations from Design (context only)
Supersede checkbox unchecked by default; Restore hidden for non-restorable reasons; Modal in ConfirmDialog.tsx; `unavailable` error kind; CSS layout tweaks; web tsconfig excludes tests.

## Strengths ✅
Never echoes server text; three-layer XSS defence; project-scoped admin summary without token hash; minimal multi-stage image; accessible dialogs and focus management.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| 4.2 | LOW | OPEN |
| R1-SEC1 | LOW | OPEN |
| R1-SEC2 | LOW | OPEN |
| R1-SEC3 | LOW | OPEN |
