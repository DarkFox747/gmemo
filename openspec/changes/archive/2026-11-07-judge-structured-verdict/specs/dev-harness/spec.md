# Delta for dev-harness

## MODIFIED Requirements

### Requirement: Compose boots from scratch

The compose `app` service SHALL run the deterministic judge (`JUDGE_STUB=true`) with its heuristic rules and default `JUDGE_STUB_CONFIDENCE` (0.9); `JUDGE_STUB_VERDICT` no longer exists. All other boot guarantees are unchanged.
(Previously: the app set `JUDGE_STUB_VERDICT=accepted`.)

#### Scenario: Smoke item still promotes
- GIVEN a fresh compose stack
- WHEN `pnpm smoke` runs
- THEN the smoke `gotcha` matches the deterministic judge's default rule (accepted, 0.9 ≥ threshold) and is applied, and the run exits 0
