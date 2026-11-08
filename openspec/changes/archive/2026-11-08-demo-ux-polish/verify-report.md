# Verify Report: demo-ux-polish (C10)

**Verdict: PASS** (2 rounds; stack-level run deferred to the final integration run)

## Round 1
- **Checks (worker, no DB):** lint, typecheck:web, build, build:web OK; 1725 unit tests passed (DB suites skipped — the shared DB was in exclusive use by the parallel C11 change).
- **crombie-reviewer:** PASS WITH WARNINGS — MEDIUM: comparison without body (DTO has no body), hard-coded colors, no screen-reader signal for diff, Shift+A not excluded, keyboard reject without confirmation. LOW: overlapping polling ticks, log spam, badge flicker, double error announcement, demo-promote arg errors.
- **crombie-security:** FINDINGS — MEDIUM: single-keystroke approve (accidental approval, A04). LOW: polling vs rate limiter (no overlap guard/backoff), demo-promote unchecked BASE_URL, style props (safe).

## Remediation (round 2, tasks 4.1–4.6)
- `A` arms + confirm (A again / Enter within 3 s); `R` focuses the reason only; Shift/Ctrl/Meta/Alt, composing, repeat, busy and editable targets ignored — pure `shortcutAction` helper with tests (orchestrator inline check OK).
- Screen-reader markers on diff segments; tokens for new colors; single error announcement.
- Polling: next tick only after the previous settles, exponential backoff to 60 s, first-failure logging, sequence guard in useAsync, badges keep last value.
- demo-promote: usage on bad args, localhost-only unless `--force`, formatted outcome.
- Spec amended: comparison covers title + summary (related DTO has no body).
- Re-run: lint, typecheck:web, build:web, unit tests OK.

## Deferred to integration run (after C11 releases the DB)
- Task 3.3: rebuild stack, `pnpm demo`, `pnpm smoke`, `pnpm demo:promote`, browser walk and screenshots.
