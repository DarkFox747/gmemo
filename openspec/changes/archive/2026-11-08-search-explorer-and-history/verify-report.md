# Verify Report: search-explorer-and-history (C13)

**Verdict: PASS** (2 rounds)

## Round 1
- **Checks (worker):** lint, build, typecheck:web, build:web OK; full DB suite 2296/2296; fresh stack: demo, smoke, demo:promote (main → exit 0; feature without --pr → usage, exit 1), 10 screenshots verified visually.
- **crombie-reviewer (high):** APPROVE_WITH_COMMENTS — recall behaviour preserved (candidate limits, concurrency, scope, repo boost, fail-soft log, cursor, staged-first all unchanged; recall test files untouched). MEDIUM: partly tautological hybridSearch test (no argument pinning); screenshots readiness check could capture error states. LOW: log prefix, per-screen failure handling, sr-only marks in field diff, unscoped `.num`, whitespace query, misleading doc comment.
- **crombie-security:** FINDINGS — LOW only (embed cost per request under the /api limiter; log prefix). Authorization order, tenant isolation, DTO without body/fields, audit without raw query verified.

## Remediation (round 2, tasks 5.1–5.4)
- Spy test pinning exact repository arguments; screenshots fail on `role="alert"`, use a `data-state` marker, catch per screen; `[search]` log prefix; sr-only diff marks + labels; scoped CSS; blank-query hint; doc comment fixed.
- Clean captures: `pnpm demo:reset` → `pnpm screenshots` (seed data only) → `pnpm demo` + `pnpm smoke` OK.
- Re-run: full DB suite **2297/2297** (1963 unit).
