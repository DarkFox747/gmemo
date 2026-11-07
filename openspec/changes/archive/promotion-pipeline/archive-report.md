# Archive Report — promotion-pipeline (local-testable vertical)

schema: archive-report-v1
change: promotion-pipeline
status: CLOSED
verdict: PASS
archived_at: 2026-07-31

## Outcome
The memory loop is CLOSED locally: `POST /promote` → injectable OIDC auth (dev stub) →
`PromoteService.promote(sessionId)` → sanitize (`assertNoSecrets`, incl. fields) → injectable Judge
(deterministic stub) → real apply to `memory`/`memory_revision`/`memory_relation` → quarantine for
rejects → session terminal state. Under the dev-harness (`JUDGE_STUB=true`, `PROMOTE_OIDC_DEV_BYPASS=true`),
`curl POST /promote` promotes the seeded pending `add` item into an authoritative `memory` row and the
session goes `promoted`. The two AWS-coupled pieces (real Bedrock judge, real GitHub-OIDC/JWKS + API
Gateway) are fail-closed skeletons behind the same seams — deferred, drop-in later.

## Pipeline
explore (2) → proposal (inline) → design (architect, ultrathink) → specs+tasks (inline) →
apply (7 batches A–G, 13 worker dispatches) → verify (security + reviewer) → remediation (1 worker:
H1+M1+M2+L1+L2+L3) → archive (inline).

## What shipped
- `PromotionRepository` (`PgPromotionRepository`): 4 op→SQL applies (add/amend/supersede/deprecate) in
  per-item transactions, `FOR UPDATE` + `current_revision==target_revision` concurrency gate, `add`/
  `supersede` dedup via `ON CONFLICT (project_id, content_hash)`, `content_tsv` never written, quarantine
  snapshot, `finalizeSession`, apply-time `project_id` re-assertion (defense-in-depth).
- Judge seam: `Judge` interface + `DeterministicJudge` stub + `BedrockJudge` fail-closed skeleton (error →
  `uncertain`, never `accepted`; `invokeModel` DEFERRED; NO aws-sdk dep).
- OIDC seam: `OidcVerifier` + `DevOidcAuthenticator` stub + `GithubOidcAuthenticator` fail-closed skeleton;
  `PromotePrincipal{repository, ref}`; endpoint enforces `ref == source_branch` AND `repo == claim`.
- `authorizePromote` on the single `RdsAuthorizer` (machine_credential path; opaque deny; tenant-bound).
- `findRepoByGithubSlug` + `findActiveMachineCredential`; `recordPromote` audit (ci/promote, no raw content).
- `POST /promote` handler + wiring; 5 config guards (superRefine + composition-root NODE_ENV double-check).
- Seed: dev machine_credential + open `main` session + pending `add` item; `.env.dev.example` stub vars.

## Requirements
REQ-01..REQ-27 satisfied. 371 tests green (83 DB-gated integration skipped without `DATABASE_URL`);
build + lint clean.

## Security (audited + remediated, holds)
0 CRITICAL / 0 HIGH after remediation. Fixed: OIDC `ref` enforcement (H1), promotion secret-scan includes
`fields` (M1), authorizePromote deny-path tests (M2), self-supersede 23514 guard (L1), atomic reject
quarantine (L2), apply-time tenant re-assertion (L3). Confirmed clean: token claim authoritative over body,
unskippable authz chain, parameterized+tenant-scoped SQL, fail-closed judge, first-writer-wins concurrency,
prod bypass impossible (double-guarded), error opacity, redacted secret quarantine.

## Deferred → backlog
- Real `BedrockJudge.invokeModel` (VPC PrivateLink + IAM + model-access grant; out-of-band `pnpm add @aws-sdk/*`).
- Real GitHub-OIDC JWKS verification + API Gateway IAM authorizer + GitHub Action YAML + real machine_credential provisioning.
- Quarantine sweep/retention job + the 1-vs-2-month decision (`quarantine.expires_at` left NULL).
- 3-way merge for stale targets (they quarantine); Web UI human-review queue for `uncertain`.
- **Rate limit on `/promote`** (L4) → backlog M-02 (needs `express-rate-limit`).

## Accepted trade-offs
- `ApplyContext.sessionId` added beyond the design interface (needed for quarantine `origin_session_id`).
- Opaque failures surface as the generic terminal 500 (per the existing opacity model), not per-code HTTP statuses.

## Human follow-up (once)
`docker compose up --build` then `curl POST /promote` (dev stubs) to see the seeded item become a memory row;
run the DB-gated suite with a real Postgres to exercise the 17 promotion integration tests.
