# Verify Report: governance-insights (C12)

**Verdict: PASS** (2 rounds)

## Round 1
- **Checks (worker):** lint, build, typecheck:web, build:web OK; full DB suite 2223/2223; fresh stack: `pnpm demo`, `pnpm smoke`, `pnpm screenshots` exit 0.
- **crombie-reviewer (high):** APPROVE_WITH_COMMENTS — metric definitions, SQL scoping, activity projection, keyset, masking and admin-only 404 match the specs (FP 3/8, FN 1/3 reconciled by hand). MEDIUM: judge-indicators card below the fold; design.md default route outdated; missing tests (foreign quarantine target, unknown job/api, non-object job detail). LOW: quarantine titles unmasked in feed, repo label could expose remote_url userinfo, inline strings, tab a11y, `z.coerce` laxness.
- **crombie-security (high):** FINDINGS — no CRITICAL/HIGH; authorization, tenant isolation, injection and rendering verified. MEDIUM: activity query cost (no supporting index), dashboard 6-connection burst. LOW: quarantine title masking, branch fact length, repo label userinfo, display_name provenance.

## Remediation (round 2, tasks 4.1–4.5)
- Migration `0011_access_log_activity_indexes.sql` (two partial indexes) + migrate test.
- Dashboard queries sequential.
- Indicators card first on Inicio; design.md default route = Inicio.
- Integration tests: foreign quarantine target → null, unknown job/api → other, non-object job detail ignored.
- Masked quarantine titles, branch cap 200, credential-free repo label, digit-only limits (+400 tests).
- Re-run: full DB suite 2236/2236; fresh stack demo/smoke OK.

## Known issue carried to C13
- `scripts/screenshots.ts` captures Inicio while still "Cargando…" — screenshot script must wait for loaded content (fixed and regenerated in C13).
