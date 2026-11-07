# Tasks — promote-oidc

`design.md` is authoritative for exact construction + security contract. No new
dependency (reuse `aws-jwt-verify` `JwtRsaVerifier`).

- [x] T001 `src/auth/oidcAuthenticator.ts`: implement `GithubOidcAuthenticator.verify` using an INJECTED generic verifier seam (default = `JwtRsaVerifier.create({ issuer: 'https://token.actions.githubusercontent.com', audience: <GITHUB_OIDC_AUDIENCE>, jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks' })`). Verify iss/aud/exp/nbf/signature; extract `repository`+`ref` → `PromotePrincipal`; any failure/missing claim → PERMISSION_DENIED (opaque). Constructor accepts an optional `verifier?` seam for tests.
- [x] T002 `src/config/index.ts`: ensure the GitHub issuer/JWKS are available (constants or config) and `GITHUB_OIDC_AUDIENCE` is required on the real path (`PROMOTE_OIDC_DEV_BYPASS=false`) per existing superRefine. No new secret fields.
- [x] T003 `src/index.ts`: on the non-bypass branch construct the real `GithubOidcAuthenticator` (with the default verifier); keep the dev authenticator branch + 4-barrier prod guard unchanged.
- [x] T004 `src/http/promote.ts` (FLAG 1): add the `source_branch == repo.default_branch` assertion alongside the existing `ref == source_branch` / `repo == principal.repository` checks → PERMISSION_DENIED on mismatch. (Use the repos row already looked up; confirm `default_branch` column via schema.)
- [x] T005 `.github/workflows/promote.yml`: trigger on PR merged to default branch; `permissions: id-token: write`; mint OIDC token with the audience; `POST /promote` with body {repo, source_branch, pr_number, merge_sha} matching the `.strict()` schema. No long-lived secrets.
- [x] T006 Tests `tests/auth/*` (inject fake verifier, no network): valid token → principal; wrong audience / wrong issuer / expired / bad signature / missing repository|ref → PERMISSION_DENIED. Handler tests: feature-branch source_branch → denied; default-branch happy path promotes; repo/ref mismatch denied.
- [x] T007 Provisioning runbook (FLAG 2): add idempotent SQL (`INSERT INTO machine_credential … ON CONFLICT …`) registering repo principal → project, with `token_hash = 'oidc:no-shared-secret'` sentinel. Put it in `terraform/README.md` (Gate-2 / machine section) or a `docs`/change note; NO seed, NO dev bypass in prod. Confirm exact columns from `docs/artefactos/lpms_schema_v2.sql`.
- [x] T008 Gate: `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm test -- --run`. All green; confirm NO dependency added.
