# Apply Progress — promote-oidc

## Batch 1 — SUCCESS (single worker, T001–T008)
Real GitHub OIDC verification wired to unblock `/promote`. No new dependency (reused
`aws-jwt-verify` `JwtRsaVerifier`). Files: `src/auth/oidcAuthenticator.ts`,
`src/index.ts`, `src/http/promote.ts`, `.github/workflows/promote.yml`,
`terraform/README.md`, tests. Gate: 451 tests / 0 failed.

## Batch 2 — remediation (verify findings) — SUCCESS
Findings closed: C1, H1, H2, M1, M2, M3, L1, L2, L3.
- C1 runbook SQL `project.key` → `slug` (+ explicit ON CONFLICT target)
- H1 migration `0006_machine_credential_unique.sql` UNIQUE(project_id, principal_name)
- H2 workflow trigger `pull_request`→`push` to default branch (ref now matches handler)
- M1 `PromoteServiceLike` interface — removed `as unknown as PromoteService` casts
- M2 labeled `nbf` fail-closed test
- M3 audience via `env:`/`process.env` in github-script
- L1 `findRepoByGithubSlug` lowercase normalization
- L2 workflow hardening (env-routed context, SHA-pinned action, `--fail-with-body`)
- L3 `slice(7)` Bearer strip

Files: `terraform/README.md`, `migrations/0006_machine_credential_unique.sql`,
`.github/workflows/promote.yml`, `src/promote/promoteService.ts`, `src/mcp/context.ts`,
`tests/http/promote.test.ts`, `tests/auth/oidc.test.ts`, `src/db/authRepository.ts`,
`src/auth/oidcAuthenticator.ts`.

Gate: build clean, lint clean, **452 tests / 0 failed** (1 new). No dep change. Verify → PASS.

Deferred (backlog): rate limit on `POST /promote` (M-02).
Open apply-time input: `GITHUB_OIDC_AUDIENCE` value (tied to deployed host — operator sets).
