# Archive Report — promote-oidc

## Outcome: DONE (verify PASS after remediation)

Wired REAL GitHub Actions OIDC verification, unblocking `/promote` (was fail-closed).
Closes the cloud write loop: a merged PR to the default branch can now promote staged
items to authoritative memory. No new dependency.

## Delivered
- `src/auth/oidcAuthenticator.ts`: `GithubOidcAuthenticator.verify` via an injected
  `OidcJwtVerifier` seam (default `JwtRsaVerifier` from `aws-jwt-verify`, GitHub issuer
  `token.actions.githubusercontent.com` + hardcoded JWKS + `GITHUB_OIDC_AUDIENCE`).
  iss/aud/exp/nbf/signature + `repository`/`ref` → `PromotePrincipal`; every failure →
  opaque `PERMISSION_DENIED`.
- `src/http/promote.ts`: default-branch enforcement (`source_branch == repo.default_branch`)
  alongside the existing `repo == principal.repository` / `ref == source_branch` checks.
- `src/index.ts`: real authenticator on the non-bypass branch; dev branch + 4-barrier
  prod guard intact.
- `.github/workflows/promote.yml`: `push` to default branch → OIDC token (`id-token:
  write`, `core.setSecret`) → `POST /promote`; env-routed context, SHA-pinned action,
  `--fail-with-body`.
- `migrations/0006_machine_credential_unique.sql`: `UNIQUE (project_id, principal_name)`
  → idempotent provisioning.
- `terraform/README.md`: machine_credential provisioning SQL (idempotent `ON CONFLICT`,
  `slug` lookup, `token_hash='oidc:no-shared-secret'` sentinel, lowercase repo slug).
- Tests: injected fake verifier, offline. **452 tests / 0 failed.**

## Verify
FAIL → remediated (1 CRITICAL + 2 HIGH + 3 MEDIUM + 3 LOW) → PASS. Auth logic
fail-closed and airtight; fork-PRs safe (GitHub grants no id-token to fork PRs).

## Apply-time operator inputs
- `GITHUB_OIDC_AUDIENCE` value (tie to the deployed promote-endpoint host).
- Register the repo `machine_credential` (runbook SQL) + set the workflow repo var
  `LPMS_OIDC_AUDIENCE` + the promote endpoint URL. Register repos with LOWERCASE slug.
- Run migration `0006` (part of the normal migrate task).

## Follow-ups (backlog)
- Rate limit on `POST /promote` (`express-rate-limit`, M-02) before live traffic.
- Web UI human-review queue for `uncertain`; quarantine sweep; 3-way merge.
