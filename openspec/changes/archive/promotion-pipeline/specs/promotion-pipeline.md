# Spec — promotion-pipeline (local-testable vertical)

schema: spec-v1
change: promotion-pipeline
status: DRAFT
date: 2026-07-30

Testable acceptance criteria. No new migration (0004 closed the gaps). No new runtime dep.

## Apply to main (PromotionRepository)
- **REQ-01** `add` promotion inserts a `memory` row (status `active`, `current_revision=1`,
  `provenance='pr_reviewed'`) + a `memory_revision` (rev 1, op `add`, `promoted_from_item`=item id).
  `content_tsv` is NEVER in any column list yet is populated (GENERATED).
- **REQ-02** `amend` locks the target `FOR UPDATE`, requires `current_revision == target_revision`
  AND `status='active'`, then UPDATEs content + `current_revision++` and inserts a `memory_revision`
  (op `amend`, rev = old+1).
- **REQ-03** `supersede` inserts a new active memory + revision, sets the old target
  `status='superseded'`, and inserts `memory_relation(supersedes, source='judge')` idempotently
  (`ON CONFLICT DO NOTHING`).
- **REQ-04** `deprecate` flips the target to `status='deprecated'`, bumps `current_revision`, and
  inserts a `memory_revision` (op `deprecate`) snapshotting the target's current content.
- **REQ-05** `add`/`supersede` dedup via `ON CONFLICT (project_id, content_hash) DO NOTHING`: an
  existing-content promote writes no new memory/revision and sets `promoted_memory_id` to the
  existing id (idempotent no-op).
- **REQ-06** Every applied op sets `staging_item.promoted_at=now()`, `promoted_memory_id`, and
  `judge_state='accepted'` under `WHERE id=$ AND promoted_at IS NULL` (first-writer-wins). Each
  apply runs in its own per-item transaction.
- **REQ-07** A stale target (missing / `current_revision != target_revision` / non-active) causes NO
  memory write (ROLLBACK) → the item is quarantined with reason `stale_target`. A `23505` unique
  violation on amend/supersede → quarantined `duplicate_content`. No 3-way merge.
- **REQ-08** All PromotionRepository SQL is parameterized and tenant-scoped (`project_id`); no string
  concatenation; `memoryRepository` stays read-only (writes live only in PromotionRepository).

## Quarantine + terminal state
- **REQ-09** `quarantineItem` writes a self-contained `quarantine` snapshot (project_id/repo_id +
  provenance breadcrumbs + content) and sets `staging_item.judge_state='rejected'`, leaving
  `promoted_at` NULL. Secret-path (`secret_detected`) rows are stored REDACTED with a category-only
  reason (never the matched secret).
- **REQ-10** `finalizeSession` sets the session status: `promoted` (all applied) / `rejected`
  (none applied, none uncertain) / `partially_promoted` (mixed) + `promoted_at`.

## Judge seam (fail-closed)
- **REQ-11** `Judge.evaluate` returns `accepted|rejected|uncertain`. `DeterministicJudge` returns its
  configured verdict. `BedrockJudge.evaluate` catches EVERY error from its (deferred) `invokeModel`
  and returns `uncertain` — NEVER `accepted`. No `@aws-sdk/*` import is added.
- **REQ-12** A persisted verdict wins: on re-run, an item already `accepted`/`uncertain`/`rejected`
  is not re-judged.

## OIDC auth for /promote (single RBAC lib)
- **REQ-13** `POST /promote` authenticates via an injectable `OidcVerifier` (NOT Cognito).
  `DevOidcAuthenticator` returns a fixed `PromotePrincipal` (dev only); `GithubOidcAuthenticator`
  is a fail-closed skeleton that throws `PERMISSION_DENIED` until real JWKS verification lands.
- **REQ-14** Authorization goes through the existing `RdsAuthorizer` via a new `authorizePromote`
  that checks an active `machine_credential` (project_id + principal_name = repo slug, non-revoked,
  unexpired, writer role) — NOT the human app_user path. Failure → opaque `PERMISSION_DENIED`.
- **REQ-15** Tenant resolves by GitHub slug (`findRepoByGithubSlug` → repo by canonical remote_url).
  The token `repository` claim is authoritative: `body.repo != claim` → opaque denial (a token for
  repo A can never promote into project B).

## POST /promote endpoint
- **REQ-16** Body is zod-validated (`repo`, `source_branch`, optional `pr_number`, `merge_sha`;
  `.strict()`). No open session for the branch → `200 { status:'no_op' }`.
- **REQ-17** On success returns `200` with `{ status, applied, deduped, quarantined, uncertain }`.
  All auth/validation failures and unexpected errors return the generic opaque error (no body echo,
  no tenant/resource/stack leakage) via the existing terminal handler.
- **REQ-18** A successful promote is audited via `recordPromote` (`actorKind='ci'`,
  `action='promote'`, detail carries sessionId/counts/prNumber/mergeSha — no raw content).

## Orchestration + idempotency
- **REQ-19** `PromoteService.promote(sessionId, meta)` processes only `promoted_at IS NULL` items in
  order: sanitize (reuse `assertNoSecrets`, secret → quarantine, judge NOT consulted) → judge (or
  reuse verdict) → apply | quarantine | leave-uncertain → finalize. A caught judge error is NEVER
  mapped to `accepted`.
- **REQ-20** Re-running `promote(sessionId)` after completion is a no-op: applies 0, writes no new
  memory/revision/quarantine rows, session status unchanged.

## Config guards (secure-by-default)
- **REQ-21** New env (`JUDGE_STUB`, `JUDGE_STUB_VERDICT`, `BEDROCK_MODEL_ID`,
  `PROMOTE_OIDC_DEV_BYPASS`, `GITHUB_OIDC_AUDIENCE`) use `z.enum(['true','false']).transform`
  (not `z.coerce.boolean`). `superRefine` makes `JUDGE_STUB=true` and `PROMOTE_OIDC_DEV_BYPASS=true`
  impossible when `NODE_ENV=production`, and requires `BEDROCK_MODEL_ID`/`GITHUB_OIDC_AUDIENCE`
  when their stub is off. Composition root adds a defense-in-depth `NODE_ENV !== 'production'` check.

## Tests + gate
- **REQ-22** Unit tests: DeterministicJudge verdicts; BedrockJudge fail-closed; PromoteService state
  machine (accepted/rejected/uncertain/stale/duplicate/secret/terminal-status/no_op); config guard
  matrix; Dev/Github OIDC authenticators.
- **REQ-23** DB-gated integration (skipped without `DATABASE_URL`): each of the 4 ops end-to-end,
  dedup, stale conflict, supersede relation idempotency, quarantine, terminal transitions, and an
  idempotent re-run.
- **REQ-24** supertest `POST /promote` (dev stubs): seeded session → `200 promoted applied:1`;
  repo-claim mismatch → opaque denial; no session → `no_op`; unknown repo → opaque denial.
- **REQ-25** `pnpm build && pnpm test -- --run && pnpm lint` all green; existing 285 tests stay passing.
- **REQ-26** Seed adds a dev machine_credential + an open `main` session + one pending `add` item so
  `curl /promote` under the harness demos the full vertical.

## Out of scope (must NOT appear)
- **REQ-27** No real Bedrock invoke / no `@aws-sdk` dep; no real GitHub-OIDC JWKS; no API Gateway
  config; no GitHub Action YAML; no quarantine sweep/retention; no 3-way merge; no Web UI; no new migration.
