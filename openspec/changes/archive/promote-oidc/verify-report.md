# Verify Report — promote-oidc

## Verdict: PASS (post-remediation)

- Pre-remediation: FAIL — 1 CRITICAL + 2 HIGH (provisioning SQL + workflow trigger;
  auth logic was already clean/fail-closed).
- Remediation batch closed all 9 findings (C1, H1, H2, M1, M2, M3, L1, L2, L3).
- Re-gate: build clean, lint clean, **452 tests / 0 failed** (1 new: nbf), no dep change.
- **Verdict flips to PASS**: CRITICAL + both HIGH closed, gate green.
- Deferred: rate limit on `POST /promote` (backlog M-02).

Gate (original apply): build clean, lint clean, 451 tests / 0 failed, no dep change.
Auth LOGIC clean/fail-closed (security: fork-PRs safe — GitHub grants no id-token
to fork `pull_request` workflows). FAIL was on provisioning SQL + the workflow trigger.

## Findings

### CRITICAL
- **C1 (review) — runbook SQL references non-existent `project.key`.** Column is
  `slug` (`lpms_schema_v2.sql`, `0001_auth_tenancy.sql`). SQL errors → machine_credential
  never inserted → `/promote` broken in prod. Fix: `WHERE slug = :project_slug`.

### HIGH
- **H1 (review) — `ON CONFLICT DO NOTHING` non-functional; no UNIQUE on
  `(project_id, principal_name)`.** Re-running duplicates rows (idempotency false).
  Fix: new migration `0006` adding `UNIQUE (project_id, principal_name)` + explicit
  `ON CONFLICT (project_id, principal_name)` target.
- **H2 (security) — workflow `pull_request` trigger mints `ref: refs/pull/<N>/merge`**,
  which the handler's `refs/heads/` strip never matches → EVERY promote denied
  (feature non-functional). Fix: trigger on `push` to the default branch (ref becomes
  `refs/heads/<default>`, matches); drop the `merged` guard (branch filter replaces it).
  No handler change.

### MEDIUM
- **M1 (review) — `as unknown as PromoteService` in test fakes** violates strict TS.
  Extract a `PromoteServiceLike` interface (expose `promote`) and type fakes + the
  relevant `AppServices` field against it (same pattern as `OidcVerifier`).
- **M2 (review) — no dedicated `nbf` (not-yet-valid) test.** Add one via a rejecting
  fake verifier.
- **M3 (security) — `${{ vars.LPMS_OIDC_AUDIENCE }}` interpolated into the
  github-script body.** Route via `env:` → `process.env.LPMS_OIDC_AUDIENCE`.

### LOW
- **L1 (security) — `findRepoByGithubSlug` case-sensitivity.** Normalize
  `ownerRepo.toLowerCase()`; enforce lowercase in the provisioning runbook.
- **L2 (review) — workflow hardening**: route `github.*`/`vars.*` context through
  `env:`; pin `actions/github-script` to a SHA; use `curl --fail-with-body`.
- **L3 (review) — `slice(7)` over `indexOf`** in the Bearer strip (readability).

### Deferred (backlog)
- Rate limit on `POST /promote` (`express-rate-limit`, M-02) — before live traffic.

## Clean (no action)
OIDC verify (iss/aud/exp/nbf/sig via `JwtRsaVerifier`, hardcoded JWKS — no SSRF),
fail-closed all paths (opaque PERMISSION_DENIED), default-branch enforcement, token
never logged (`core.setSecret`), dev-bypass 4-barrier prod guard intact, parameterized
SQL, fork-PR id-token safe, tenant-scoped credential lookup.

## Remediation plan
Single worker: C1, H1 (migration 0006 + ON CONFLICT), H2 (trigger), M1, M2, M3, L1,
L2, L3. Re-gate (`build`/`test`/`lint`). Verdict flips to PASS when CRITICAL + both
HIGH are closed and the gate is green.
