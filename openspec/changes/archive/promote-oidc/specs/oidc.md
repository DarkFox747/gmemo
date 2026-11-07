# Spec — promote-oidc

`design.md` is authoritative for exact construction, security contract, and file
matrix. These are the outcome requirements.

## Requirements

### REQ-01 — Real GitHub OIDC verification
`GithubOidcAuthenticator.verify(token)` MUST verify the GitHub Actions OIDC JWT using
`aws-jwt-verify`'s generic `JwtRsaVerifier` (NO new dependency): issuer
`https://token.actions.githubusercontent.com`, JWKS
`https://token.actions.githubusercontent.com/.well-known/jwks`, audience =
`GITHUB_OIDC_AUDIENCE`, checking `iss`/`aud`/`exp`/`nbf`/signature.

### REQ-02 — Injected verifier seam (offline tests)
The verifier MUST be injectable (narrow seam, mirroring `CognitoAuthenticator`) so unit
tests run with a fake verifier and NO live network / no real JWKS fetch.

### REQ-03 — Principal extraction
On success, `verify` MUST extract `repository` + `ref` into a `PromotePrincipal`.
`sub`/`repository_owner` are intentionally NOT bound (redundant given repository).

### REQ-04 — Fail-closed
Any verification failure — wrong audience, wrong issuer, expired/not-yet-valid, bad
signature, or missing `repository`/`ref` — MUST result in `PERMISSION_DENIED` and MUST
NEVER allow a promote. No error detail that enables enumeration.

### REQ-05 — Default-branch enforcement (FLAG 1)
The `/promote` handler MUST additionally assert `source_branch == repo.default_branch`
(in addition to the existing `ref == source_branch` and `repo == principal.repository`
checks), so a feature-branch OIDC run cannot promote to main memory. Failure →
`PERMISSION_DENIED`.

### REQ-06 — Composition root
`src/index.ts` MUST use the real `GithubOidcAuthenticator` when
`PROMOTE_OIDC_DEV_BYPASS=false`, keeping the dev authenticator branch and its
4-barrier prod guard intact. Config MUST require `GITHUB_OIDC_AUDIENCE` on the real
path (existing superRefine).

### REQ-07 — GitHub Action workflow
`.github/workflows/promote.yml` MUST trigger on PR merge to the default branch,
request an OIDC token with `permissions: id-token: write` and the configured audience,
and `POST /promote` with a body matching the handler's `.strict()` schema (repo,
source_branch, pr_number, merge_sha). NO long-lived secrets.

### REQ-08 — machine_credential provisioning (FLAG 2)
Provisioning MUST be documented as idempotent runbook SQL (`INSERT … ON CONFLICT`),
registering the repo principal → project mapping that `findActiveMachineCredential`
reads. `token_hash` (NOT NULL, unused on OIDC) MUST use a clear sentinel
`'oidc:no-shared-secret'`. NO dev bypass in production; NO seed on the pilot DB.

## Acceptance Criteria
- Unit tests (fake verifier): valid token → `PromotePrincipal{repository, ref}`;
  wrong audience / wrong issuer / expired / bad signature / missing claim →
  `PERMISSION_DENIED`.
- Handler tests: feature-branch `source_branch` (≠ default) → `PERMISSION_DENIED`;
  default-branch happy path still promotes; `repo`/`ref` mismatch still denied.
- `pnpm build && pnpm test -- --run && pnpm lint` green; no new dependency added.
- No secrets committed; Action uses OIDC only.
