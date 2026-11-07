# Design: promote-oidc — real GitHub Actions OIDC verification for `/promote`

## FLAGS — needs your confirmation before implementation

1. **Default-branch enforcement (security, decision #2 extension).** The current
   handler binds `principal.ref == body.source_branch`, but nothing forces the
   promoted branch to be the repo's *default* branch. A valid OIDC token minted by
   a workflow run on a **feature branch** (ref `refs/heads/feature-x`) could
   `POST /promote` with `source_branch=feature-x` and promote that branch's staged
   items into main memory — bypassing the "promotion happens exclusively via PR
   merge to main" invariant (project-map summary, docs/04). **Recommendation:** add
   a server-side assertion that `source_branch == repo.default_branch` in the
   handler (using the already-resolved `repo` row's `default_branch`). This is a
   ~3-line addition and is the ONLY change outside the pure verify seam. Confirm you
   want it in-scope (I recommend YES — it closes token-replay-to-wrong-branch).

2. **`machine_credential.token_hash` is `NOT NULL` but unused on the OIDC path.**
   The OIDC principal is authenticated by JWKS, not a stored secret, so there is no
   token to hash. Provisioning SQL must still supply a value. **Recommendation:**
   insert a documented sentinel `'oidc:no-shared-secret'` and note in the runbook
   that a future migration MAY make the column nullable. Confirm the sentinel
   approach vs. a migration now (I recommend the sentinel — YAGNI, no schema churn).

3. **Audience value.** I recommend `GITHUB_OIDC_AUDIENCE` = the canonical public
   HTTPS promote endpoint URL of the pilot (e.g. `https://<pilot-domain>/promote`).
   Confirm the exact host so the runbook + Action can pin it. (Terraform currently
   ships a placeholder — project-map infra §mode.)

## Technical Approach

The seam, the handler, the config field, the boot guards, and the DB tables all
already exist (delivered by `promotion-pipeline`). This change fills the body of
`GithubOidcAuthenticator.verify` and wires a real JWKS verifier — nothing more.

We mirror the **existing Cognito pattern exactly**: construct the concrete
`aws-jwt-verify` verifier at the composition root, inject it as a narrow structural
seam into the authenticator, and let tests substitute a plain-object fake (no live
network). The generic verifier `JwtRsaVerifier` ships in the `aws-jwt-verify`
package already in `dependencies` (subpath `aws-jwt-verify/jwt-rsa`, confirmed
exported) — **no new runtime dependency**. It validates `iss`, `aud`, `exp`, `nbf`,
and RSA signature against a cached/auto-refreshed JWKS by default; we only add
extraction of `repository` + `ref` and fail-closed error mapping.

## Architecture Decisions

### Decision: Direct app verify at `/promote`, defer API Gateway IAM authorizer

**Choice**: The Express app verifies the GitHub OIDC JWT directly inside
`GithubOidcAuthenticator.verify`, reached over the existing ALB → Fargate path. No
API Gateway, no IAM authorizer, no new infra.

**Alternatives considered**: (a) API Gateway with a Lambda/JWT authorizer in front
of the service; (b) API Gateway IAM authorizer + SigV4.

**Rationale**: The verification seam and its injection point already exist and are
unit-testable in-process; `aws-jwt-verify` does full JWKS verification in-app with
built-in caching, so an edge authorizer would duplicate logic already owned by the
app and add a second infra surface (routes, stage, authorizer, IAM) for zero
security gain — the app still must map claims → `PromotePrincipal` → machine
credential. The pilot topology is single-AZ ALB→Fargate (project-map infra); adding
API Gateway now is speculative (YAGNI). API Gateway is genuinely **deferrable**: it
becomes worth it only if we later need edge throttling/WAF/usage-plans for
`/promote`, which is already listed under `deferred_to_hardening`. **Confirmed
deferrable.**

### Decision: Reuse `JwtRsaVerifier` (generic) from `aws-jwt-verify` — no new dep

**Choice**: `import { JwtRsaVerifier } from 'aws-jwt-verify/jwt-rsa'` and
`JwtRsaVerifier.create({ issuer, audience, jwksUri })`.

**Alternatives considered**: (a) add `jose` / `jwks-rsa`; (b) hand-roll JWKS fetch +
`crypto.verify`.

**Rationale**: The package is already a dependency (Cognito Gate 1 uses
`CognitoJwtVerifier` from the same lib). The generic `JwtRsaVerifier` is the
supported entry point for arbitrary issuers — its `VerifyProperties` accepts
`audience` (string, verified against `aud`), `issuer`, and `jwksUri`, and it checks
`exp`/`nbf`/signature by default with automatic JWKS caching + key rotation.
Confirmed at `node_modules/aws-jwt-verify/jwt-rsa.d.ts` and the `./jwt-rsa` export in
the package's `exports` map. Any new dep or hand-rolled crypto would be strictly
worse (audit surface, correctness risk) for capability we already have. **No FLAG
needed — the lib does generic JWKS.**

### Decision: Inject the JWKS verifier as a narrow seam (mirror Cognito)

**Choice**: Add a structural interface `OidcJwtVerifier { verify(token: string):
Promise<GithubOidcClaims> }`. `GithubOidcAuthenticator`'s constructor takes this
seam (replacing the current `audience: string` arg). The composition root builds the
real `JwtRsaVerifier` with issuer/audience/jwksUri and injects it.

**Alternatives considered**: Keep `constructor(audience)` and call
`JwtRsaVerifier.create` inside the class.

**Rationale**: Constructing the verifier inside the class would force tests to hit
`token.actions.githubusercontent.com` for JWKS (live network, flaky, forbidden by
test policy "NO live network"). Injection is the identical shape already proven for
`CognitoAuthenticator(cognitoVerifier)` (`src/auth/authenticator.ts`,
`tests/auth/authenticator.test.ts` `makeFakeVerifier`), so tests inject a
`vi.fn()`-backed fake. Consistency with the sibling seam beats a one-off.

### Decision: GitHub issuer + JWKS URI as module constants, not config

**Choice**: Hard-code `GITHUB_OIDC_ISSUER =
'https://token.actions.githubusercontent.com'` and `GITHUB_OIDC_JWKS_URI =
'https://token.actions.githubusercontent.com/.well-known/jwks'` as constants in
`oidcAuthenticator.ts`. Only `GITHUB_OIDC_AUDIENCE` stays in config.

**Alternatives considered**: New `GITHUB_OIDC_ISSUER` / `GITHUB_OIDC_JWKS_URI` env
fields.

**Rationale**: These values are fixed by GitHub's platform, not per-environment;
making them config invites misconfiguration and adds superRefine surface for no
benefit (YAGNI). The audience IS per-deployment (it's the service URL) so it remains
the single configurable input — already wired.

### Decision: machine_credential provisioning via idempotent runbook SQL

**Choice**: A documented, operator-run idempotent `INSERT … ON CONFLICT DO NOTHING`
in a runbook. Not a prod seed, not Terraform.

**Alternatives considered**: (a) prod-reachable seed script; (b) Terraform-managed
row.

**Rationale**: A prod-reachable seed re-introduces exactly the kind of automatic
write path we fail-close (the dev seed is DEV-only by design). Terraform would put
application tenancy data into infra state — wrong lifecycle boundary; repo→project
onboarding is an app-domain action gated by the (still-open) ticket workflow, not an
infra apply. A runbook SQL is the minimal safe mechanism: human-approved,
auditable, idempotent, no new code path. NO dev bypass reachable in prod.

## Security Contract (Decision #2 — resolved)

**Trust anchor:** GitHub signs OIDC tokens with private keys whose public halves are
published at the JWKS URI. Forging a token is infeasible without GitHub's key;
`JwtRsaVerifier` rejects anything not signed by a current JWKS key.

**Claims verified inside `verify` (by `JwtRsaVerifier`, fail-closed on any):**
- `iss` == `https://token.actions.githubusercontent.com` (exact)
- `aud` == `GITHUB_OIDC_AUDIENCE` (the pilot promote-endpoint URL)
- `exp` / `nbf` valid (default `graceSeconds` = 0) → expired/not-yet-valid rejected
- RSA signature valid against cached JWKS

**Claims extracted → `PromotePrincipal`:** `repository` (→ `principal.repository`)
and `ref` (→ `principal.ref`). If either is absent/empty → `PERMISSION_DENIED`.
`repository_owner` and `sub` are NOT bound as separate gates: `repository` is
strictly more specific than `repository_owner` (owner is implied by owner/repo), and
`sub` is a composite of claims we already bind — adding them is redundant (YAGNI).

**Layered downstream enforcement (unchanged, plus FLAG #1):**
1. Handler: `body.repo === principal.repository` (token authoritative).
2. Handler: `stripRefsHeads(principal.ref) === body.source_branch`.
3. **[FLAG #1] Handler (proposed): `body.source_branch === repo.default_branch`** —
   forces promotion only from the default branch.
4. Authorizer: `findActiveMachineCredential(projectId, principal.repository)` — the
   repo must be explicitly provisioned as an active, non-revoked, non-expired
   credential for THIS project with a write role. This is the per-repo allowlist.

**Fail-closed paths (all → `AppError(PERMISSION_DENIED)`, no promote, no
enumeration):**
- Missing/malformed `Authorization` header or missing `Bearer ` prefix.
- Wrong `aud`, wrong `iss`, expired/nbf, bad signature, unknown `kid`.
- JWKS fetch failure / verifier throws (any reason).
- `repository` or `ref` claim missing/empty.
- `body.repo != repository` or `source_branch != ref` (or != default_branch, FLAG #1).
- No matching active `machine_credential`.

**Why a valid-but-wrong token can't promote:** a token from another repo carries
that repo's `repository` claim → no machine_credential for it in this project →
denied. A token minted for a different audience (e.g. another service) → `aud`
mismatch → denied. A replayed feature-branch token → default-branch assertion (FLAG
#1) denies.

## Data Flow

    GitHub Actions (PR merged to default)
      │  core.getIDToken(GITHUB_OIDC_AUDIENCE)  → OIDC JWT (id-token: write)
      ▼
    POST /promote  Authorization: Bearer <jwt>   body:{repo,source_branch,pr_number,merge_sha}
      │
      ▼  (ALB → Fargate → Express handler)
    makePromoteHandler
      │  req.headers.authorization
      ▼
    GithubOidcAuthenticator.verify(authorization)
      │  strip "Bearer " → JwtRsaVerifier.verify(token)
      │      ├─ iss/aud/exp/nbf/signature  (JWKS cached & auto-refreshed)
      │      └─ extract {repository, ref}  → PromotePrincipal | PERMISSION_DENIED
      ▼
    handler binds  repo==repository  ·  ref==source_branch  ·  [FLAG#1 ==default_branch]
      ▼
    RdsAuthorizer.authorizePromote(principal, tenant)
      │  findActiveMachineCredential(projectId, principal.repository)  → role | DENY
      ▼
    PromoteService  (sanitize → judge → apply|quarantine)   [unchanged]

## Config

Reuse the existing `GITHUB_OIDC_AUDIENCE` field and its existing `superRefine`
(required when `PROMOTE_OIDC_DEV_BYPASS=false`) — **no new config field**. Issuer and
JWKS URI are module constants (see decision above). The existing prod guard
(`PROMOTE_OIDC_DEV_BYPASS=true` forbidden when `NODE_ENV=production`) is untouched.

## Composition Root

The `else` branch in `src/index.ts` (§5f) already constructs
`new GithubOidcAuthenticator(config.GITHUB_OIDC_AUDIENCE!)`. Change: build the real
verifier first, then inject it.

    const githubOidcVerifier = JwtRsaVerifier.create({
      issuer: GITHUB_OIDC_ISSUER,
      audience: config.GITHUB_OIDC_AUDIENCE!,   // superRefine guarantees present here
      jwksUri: GITHUB_OIDC_JWKS_URI,
    });
    oidcVerifier = new GithubOidcAuthenticator(githubOidcVerifier);

The dev branch (`DevOidcAuthenticator`) and its 4 barriers (loadConfig fail-fast +
`NODE_ENV !== 'production'` structural guard + warn logs) stay exactly as-is.

## GitHub Action (`.github/workflows/promote.yml`)

- **Trigger:** `pull_request` `types: [closed]`, guarded by
  `if: github.event.pull_request.merged == true && github.event.pull_request.base.ref == <default>`.
- **Permissions (job-level, least privilege):** `id-token: write`, `contents: read`.
- **Steps:** mint token with the pinned audience, then POST. No long-lived secrets;
  the promote endpoint URL is a repo/org **variable** (`vars.LPMS_PROMOTE_URL`), not
  a secret.

Sketch (illustrative, not product code):

    permissions:
      id-token: write
      contents: read
    steps:
      - id: tok
        uses: actions/github-script@v7
        with:
          script: |
            const t = await core.getIDToken('${{ vars.LPMS_OIDC_AUDIENCE }}');
            core.setSecret(t); core.setOutput('token', t);
      - run: |
          curl -sS -f -X POST "${{ vars.LPMS_PROMOTE_URL }}" \
            -H "Authorization: Bearer ${{ steps.tok.outputs.token }}" \
            -H "Content-Type: application/json" \
            -d '{"repo":"${{ github.repository }}","source_branch":"${{ github.event.pull_request.base.ref }}","pr_number":${{ github.event.pull_request.number }},"merge_sha":"${{ github.event.pull_request.merge_commit_sha }}"}'

Body matches the `.strict()` `PromoteBody` schema exactly: `repo`, `source_branch`
(required), `pr_number` (int), `merge_sha` (string). No extra keys (`.strict()`).

## machine_credential Provisioning (Decision #3 — runbook SQL)

Operator-run, idempotent, one row per (project, repo). `token_hash` uses the FLAG #2
sentinel; `expires_at` set per rotation policy (recommend 1 year); `role`
`service_agent`.

    -- runbook: register a repo's CI as an OIDC promote principal for a project
    INSERT INTO machine_credential
      (project_id, principal_name, token_hash, role, expires_at)
    VALUES
      ((SELECT id FROM project WHERE key = :project_key),
       :owner_repo,                    -- e.g. 'crombie-dev/lpms-cloud' == OIDC repository claim
       'oidc:no-shared-secret',        -- FLAG #2 sentinel; JWKS-authenticated, no stored secret
       'service_agent',
       now() + interval '1 year')
    ON CONFLICT DO NOTHING;

The `repo` row (`remote_url = https://github.com/<owner_repo>.git`) must already
exist from onboarding so `findRepoByGithubSlug`/tenant resolution succeeds. To
revoke: `UPDATE machine_credential SET revoked_at = now() WHERE …`.

## Test Strategy (no live network)

Mirror `tests/auth/authenticator.test.ts` `makeFakeVerifier`: inject a plain
`{ verify: vi.fn() }` fake `OidcJwtVerifier` into `GithubOidcAuthenticator`.

| Case | Fake behavior | Expected |
|------|---------------|----------|
| valid token | resolves `{repository:'o/r', ref:'refs/heads/main', …}` | returns `PromotePrincipal {repository:'o/r', ref:'refs/heads/main'}` |
| missing/no-Bearer header | (not reached) | `PERMISSION_DENIED` |
| wrong audience | fake rejects (simulating `aud` fail) | `PERMISSION_DENIED` |
| wrong issuer | fake rejects | `PERMISSION_DENIED` |
| expired | fake rejects | `PERMISSION_DENIED` |
| bad signature | fake rejects | `PERMISSION_DENIED` |
| missing `repository` claim | resolves `{ref:'…'}` (no repository) | `PERMISSION_DENIED` |
| missing `ref` claim | resolves `{repository:'o/r'}` | `PERMISSION_DENIED` |

We do NOT test `JwtRsaVerifier`'s own JWKS/crypto logic (that's the library's) — the
fake stands in for it, keeping tests offline. Existing `tests/auth/oidc.test.ts`
extends to cover the injected-fake happy + fail paths; the `DevOidcAuthenticator`
tests stay unchanged.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/auth/oidcAuthenticator.ts` | Modify | Add `OidcJwtVerifier` seam + `GITHUB_OIDC_ISSUER`/`GITHUB_OIDC_JWKS_URI` constants; change `GithubOidcAuthenticator` ctor to take the seam; implement `verify` (strip Bearer → `verifier.verify` → extract `repository`+`ref` → principal; any throw / missing claim → `PERMISSION_DENIED`). |
| `src/index.ts` | Modify | In the §5f `else` branch, build `JwtRsaVerifier.create({issuer,audience,jwksUri})` and inject into `GithubOidcAuthenticator`. Dev branch + guards unchanged. |
| `src/http/promote.ts` | Modify | **[FLAG #1, if approved]** add `body.source_branch === repo.default_branch` assertion → `PERMISSION_DENIED`. |
| `.github/workflows/promote.yml` | Create | PR-merged-to-default trigger; `id-token: write`; mint OIDC token with audience; `POST /promote` with strict body. No secrets. |
| `tests/auth/oidc.test.ts` | Modify | Add injected-fake cases: valid→principal; wrong aud/iss/expired/bad-sig/missing-repository/missing-ref → `PERMISSION_DENIED`. |
| `docs/03-auth-identidad-rbac.md` | Modify | Document the OIDC promote contract + the machine_credential provisioning runbook SQL + sentinel `token_hash` note. |

### Implementation order (tasks-friendly)

1. `oidcAuthenticator.ts`: seam + constants + real `verify` (+ tests red→green).
2. `tests/auth/oidc.test.ts`: full fail-closed matrix.
3. `src/index.ts`: composition-root wiring (real verifier injected).
4. **[FLAG #1]** `promote.ts` default-branch assertion + test.
5. `.github/workflows/promote.yml`.
6. `docs/03` runbook + provisioning SQL.

### Verify gate

`pnpm build && pnpm test -- --run && pnpm lint`
