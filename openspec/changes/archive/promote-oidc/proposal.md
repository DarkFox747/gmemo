# Proposal — promote-oidc

## Why
`/promote` is the machine write-path (PR-merge → apply staged items to memory). It
runs behind an injectable OIDC seam whose real verifier is still DEFERRED:
`GithubOidcAuthenticator.verify` (`src/auth/oidcAuthenticator.ts`) throws
`PERMISSION_DENIED` (fail-closed skeleton). So in the AWS pilot `/promote` is
effectively closed. This change wires REAL GitHub Actions OIDC verification so a
merged PR can promote, closing the cloud write loop.

## Chosen approach — real GitHub OIDC verify, minimal surface
Implement `GithubOidcAuthenticator.verify` as a drop-in replacement behind the
existing seam (no orchestration change):
- Verify the GitHub Actions OIDC JWT against GitHub's JWKS
  (`https://token.actions.githubusercontent.com/.well-known/jwks`), issuer
  `https://token.actions.githubusercontent.com`, and the configured audience
  (`GITHUB_OIDC_AUDIENCE`, already a config field).
- **Reuse `aws-jwt-verify`'s generic `JwtVerifier`** (issuer + audience + jwksUri) —
  NO new dependency (same lib already used for Cognito Gate 1).
- Extract `repository` + `ref` claims → `PromotePrincipal`. The downstream
  `authorizePromote` + the existing `ref == source_branch` / `repo == claim`
  enforcement (from promotion-pipeline) stay as-is.
- **GitHub Action workflow** (`.github/workflows/promote.yml`): on PR merge to the
  default branch, request an OIDC token (`permissions: id-token: write`) with the
  agreed audience and `POST /promote` with the repo/branch/PR body.
- **machine_credential provisioning**: document + provide the SQL (runbook / a
  guarded non-dev seed path) to register the repo principal → project mapping that
  `findActiveMachineCredential` looks up. NO dev bypass in prod.

## Scope boundaries
IN: real `GithubOidcAuthenticator.verify`; config for the GitHub JWKS/issuer (reuse
`GITHUB_OIDC_AUDIENCE`); the Action YAML; machine_credential provisioning runbook/SQL;
unit tests with the JWKS verifier mocked (valid token → principal; wrong
audience/issuer/expired/forged → PERMISSION_DENIED); composition-root wiring to use the
real authenticator when `PROMOTE_OIDC_DEV_BYPASS=false`.

OUT (later / separate): API Gateway IAM authorizer (the app verifies the OIDC JWT
directly at `/promote`, reachable via the existing ALB — no new infra needed for the
pilot); Web UI human-review queue; quarantine sweep; 3-way merge.

## OPEN DECISIONS for the architect to resolve/FLAG
1. **Direct app verify vs API Gateway authorizer.** Preference: the app verifies the
   OIDC JWT directly at `/promote` (leanest, reuses ALB) — confirm this is sound and
   that API Gateway is genuinely deferrable, or FLAG if not.
2. **Audience value + claim binding.** Pick the audience string convention and confirm
   which claims to bind (`repository`, `ref`, `sub`, `repository_owner`) and how
   tightly (e.g. require `ref == refs/heads/<default>` and `repository` allowlist via
   machine_credential). FLAG the exact security contract.
3. **machine_credential provisioning mechanism** — runbook SQL vs a prod-guarded seed
   vs Terraform. Pick the minimal safe one.

## Affected Areas
| Area | Files | Change |
|------|-------|--------|
| OIDC verify | `src/auth/oidcAuthenticator.ts` | implement `verify` (GitHub JWKS via aws-jwt-verify generic) |
| Config | `src/config/index.ts` | GitHub issuer/JWKS + audience handling (reuse `GITHUB_OIDC_AUDIENCE`) |
| Composition | `src/index.ts` | real authenticator on the non-bypass branch |
| CI | `.github/workflows/promote.yml` | PR-merge → OIDC token → POST /promote |
| Provisioning | runbook / seed SQL | register machine_credential (repo→project) |
| Tests | `tests/auth/*` | mocked-JWKS verify happy + fail-closed paths |

## Constraints
- Fail-closed: any verification failure → `PERMISSION_DENIED`, never a promote.
- No new runtime dependency (reuse `aws-jwt-verify`).
- No dev bypass reachable in production (existing prod guards preserved).
- Preserve the promotion-pipeline security enforcement (`ref`/`repo` binding).
- pnpm-ONLY; no secrets committed; Action uses OIDC (no long-lived secrets).
