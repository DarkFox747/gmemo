# Promotion Specification

## Purpose

Promotion of staged items into main memory after a PR merge: the promotion schema, applying the four ops, quarantine, the judge seam, `POST /promote` authenticated by GitHub Actions OIDC and authorized through `machine_credential`, and idempotent orchestration. Judge and OIDC dev bypasses are impossible in production.

## Requirements

### Requirement: Promotion schema (migration 0004)

`migrations/0004_promotion_gaps.sql` MUST follow the numbered, idempotent format, run standalone (`DATABASE_URL` only) and be a no-op when re-applied. `staging_item` MUST gain nullable `promoted_at timestamptz` and `promoted_memory_id uuid` (FK to `memory(id) ON DELETE SET NULL`) via `ADD COLUMN IF NOT EXISTS`, supporting `UPDATE ... WHERE id=$ AND promoted_at IS NULL`. The `staging_status` enum MUST contain `partially_promoted`. A `quarantine` table MUST be a self-contained snapshot: content columns (`op, type, title, summary, body, fields, content_hash, judge_reason, author_identity`), tenant FKs (`project_id`, `repo_id`), un-FK'd breadcrumbs (`origin_session_id`, `origin_item_id`), `quarantined_at NOT NULL DEFAULT now()` and nullable `expires_at`, with no FK to `staging_item`, the same budget CHECKs as `staging_item`, and indexes on `project_id` and `expires_at`. Retention MUST NOT be encoded in DDL. `StagingItemRow` and `LIST_STAGING_ITEMS_SQL` MUST carry the new columns, and 0001-0003 behavior MUST NOT change.

Source: promotion-schema-gaps

#### Scenario: Quarantine outlives its origin

- GIVEN a quarantine snapshot of a staging item
- WHEN the origin `staging_item` row is deleted
- THEN the snapshot remains

#### Scenario: Re-apply

- GIVEN migration 0004 already applied
- WHEN applying it again
- THEN it is a no-op (asserted by a DB-gated test that skips without `DATABASE_URL`)

### Requirement: Apply ops to main

`PromotionRepository` MUST apply each op in its own per-item transaction with parameterized, tenant-scoped SQL, and `memoryRepository` SHALL stay read-only. `add` MUST insert an active `memory` (`current_revision=1`, `provenance='pr_reviewed'`) and a `memory_revision` (rev 1, `promoted_from_item`). `amend` MUST lock the target `FOR UPDATE`, require `current_revision == target_revision` and `status='active'`, update content and increment the revision. `supersede` MUST insert a new active memory and revision, set the old target `superseded` and insert `memory_relation(supersedes, source='judge')` with `ON CONFLICT DO NOTHING`. `deprecate` MUST set `deprecated`, bump `current_revision` and snapshot the content into a revision. `add` and `supersede` MUST dedupe via `ON CONFLICT (project_id, content_hash) DO NOTHING`, setting `promoted_memory_id` to the existing id. Every applied op MUST set `promoted_at`, `promoted_memory_id` and `judge_state='accepted'` under `WHERE id=$ AND promoted_at IS NULL`. `content_tsv` MUST NEVER appear in a column list.

Source: promotion-pipeline

#### Scenario: Add

- GIVEN an accepted pending add item
- WHEN applied
- THEN an active memory with revision 1 exists and the item records `promoted_at`

#### Scenario: Stale target

- GIVEN an amend whose target is missing or non-active at apply time
- WHEN applied
- THEN nothing is written (ROLLBACK) and the item is quarantined with reason `stale_target`
- AND a target whose revision is merely no longer current is handled before apply as `uncertain`/`stale_target` (see "Stale target revision goes to human review")

#### Scenario: Duplicate content on amend or supersede

- GIVEN a `23505` unique violation
- WHEN applying
- THEN the item is quarantined as `duplicate_content`

#### Scenario: Existing content

- GIVEN content already in `memory`
- WHEN promoting an add of it
- THEN no new memory or revision is written and `promoted_memory_id` is the existing id

### Requirement: Quarantine and session terminal state

`quarantineItem` MUST write a self-contained snapshot and set `judge_state='rejected'`, leaving `promoted_at` NULL; `secret_detected` rows MUST be stored redacted with a category-only reason. `finalizeSession` MUST set `promoted` (all applied), `rejected` (none applied, none uncertain) or `partially_promoted` (mixed) plus `promoted_at`.

Source: promotion-pipeline

#### Scenario: Mixed outcome

- GIVEN one applied and one quarantined item
- WHEN finalizing
- THEN the session status is `partially_promoted`

### Requirement: Judge seam, fail-closed

`Judge.evaluate` MUST return `accepted`, `rejected` or `uncertain`. `DeterministicJudge` MUST return a structured verdict from heuristic rules with confidence `JUDGE_STUB_CONFIDENCE` (see "Structured judge verdict" and "Judge configuration"). `BedrockJudge.evaluate` MUST catch every error and return `uncertain`, never `accepted`. A persisted verdict MUST win: items already judged are not re-judged on re-run. The Bedrock-backed model call is specified in `bedrock-clients`.

Source: promotion-pipeline

#### Scenario: Judge error

- GIVEN the judge's model call throws
- WHEN evaluating
- THEN `uncertain` is returned

### Requirement: Promotion orchestration and idempotency

`PromoteService.promote(sessionId, meta)` MUST process only `promoted_at IS NULL` items in order: sanitize (reuse `assertNoSecrets`; a secret quarantines without consulting the judge), judge or reuse the verdict, then apply, quarantine or leave uncertain, then finalize. A caught judge error MUST NEVER be mapped to `accepted`. Re-running after completion MUST apply 0 items, write no new memory, revision or quarantine rows and leave the session status unchanged. Repeated promotion notifications MUST NOT apply, quarantine, queue or notify an item twice.

Source: promotion-pipeline, judge-structured-verdict

#### Scenario: Second promotion is a no-op

- GIVEN a session already promoted
- WHEN the same promotion is received again
- THEN nothing is applied, quarantined or notified again

#### Scenario: Re-run

- GIVEN a completed promotion
- WHEN promoting the same session again
- THEN nothing changes

### Requirement: POST /promote endpoint

The body MUST be zod-validated and `.strict()` (`repo`, `source_branch`, optional `pr_number`, `merge_sha`). No open session for the branch MUST return `200 { status:'no_op' }`. Success MUST return `200` with `{ status, applied, deduped, quarantined, uncertain }`. All auth, validation and unexpected failures MUST return the generic opaque error (no body echo, no tenant, resource or stack leakage). A successful promote MUST be audited via `recordPromote` (`actorKind='ci'`, `action='promote'`, detail with sessionId, counts, prNumber, mergeSha and no raw content).

Source: promotion-pipeline

#### Scenario: Promote seeded session

- GIVEN an open session with one accepted item and dev stubs
- WHEN posting `/promote`
- THEN it returns 200 `promoted` with `applied: 1`

#### Scenario: No session

- GIVEN no open session for the branch
- WHEN posting `/promote`
- THEN it returns `{ status: 'no_op' }`

### Requirement: Machine authorization and tenant binding

Authorization MUST go through `RdsAuthorizer.authorizePromote`, checking an active `machine_credential` (project, `principal_name` = repo slug, non-revoked, unexpired, writer role), not the human `app_user` path; failure is an opaque `PERMISSION_DENIED`. Tenant MUST resolve via `findRepoByGithubSlug`. The token `repository` claim is authoritative: `body.repo != claim` MUST yield an opaque denial so a token for repo A can never promote into project B.

Source: promotion-pipeline

#### Scenario: Repo claim mismatch

- GIVEN a token for repo A and a body naming repo B
- WHEN posting `/promote`
- THEN access is denied opaquely

#### Scenario: Unknown repo

- GIVEN a repo slug with no `repo` row
- WHEN posting `/promote`
- THEN access is denied opaquely

### Requirement: GitHub OIDC verification

`GithubOidcAuthenticator.verify(token)` MUST verify the GitHub Actions OIDC JWT using `aws-jwt-verify`'s generic `JwtRsaVerifier` (no new dependency): issuer `https://token.actions.githubusercontent.com`, its JWKS endpoint, audience `GITHUB_OIDC_AUDIENCE`, checking `iss`, `aud`, `exp`, `nbf` and signature. On success it MUST extract `repository` and `ref` into a `PromotePrincipal` (`sub` and `repository_owner` are intentionally not bound). The verifier MUST be injectable so unit tests use a fake with no network.

Source: promote-oidc

#### Scenario: Valid token

- GIVEN a valid token from the fake verifier
- WHEN verifying
- THEN a `PromotePrincipal{repository, ref}` is returned

### Requirement: OIDC fail-closed and default-branch enforcement

Any verification failure (wrong audience, wrong issuer, expired or not-yet-valid, bad signature, missing `repository` or `ref`) MUST result in `PERMISSION_DENIED` with no enumerable detail. For the merged event, the `/promote` handler MUST assert `repo == principal.repository` and that the token `ref` is `refs/heads/<repo.default_branch>`, its `event_name` is `push` and its `job_workflow_ref` is `<repository>/.github/workflows/promote.yml@refs/heads/<repo.default_branch>` (the trusted post-merge workflow; any other workflow file or event on the default branch, e.g. `workflow_dispatch`, `schedule` or `pull_request_target`, is denied; a missing claim is denied). The session promoted is the one of `source_branch`: either the default branch itself, or a feature branch, in which case `pr_number` MUST be present and is recorded as the origin PR (HU-04.1).

Source: promote-oidc; feature-branch-promotion

#### Scenario: Merged PR promotes its feature branch
- GIVEN an open session on `feature/x` with an accepted item and a token minted on the default branch
- WHEN `/promote` receives `{repo, source_branch:"feature/x", pr_number:7}`
- THEN the item is applied with `origin_branch = feature/x` and `origin_pr = 7`, and the session is promoted

#### Scenario: Repeated merge event is idempotent
- GIVEN the feature session was already promoted
- WHEN the same event arrives again
- THEN the response is `no_op` and nothing changes

#### Scenario: Feature source without a PR number
- GIVEN a token minted on the default branch
- WHEN `/promote` receives a feature `source_branch` without `pr_number`
- THEN `PERMISSION_DENIED` is returned

#### Scenario: Token not minted on the default branch
- GIVEN a valid token whose `ref` is a feature branch or `refs/pull/<n>/merge`
- WHEN `/promote` is called for the merged event (any `source_branch`)
- THEN `PERMISSION_DENIED` is returned

#### Scenario: Default-branch token from another workflow or event
- GIVEN a valid token with `ref = refs/heads/<default>` whose `event_name` is not `push` (e.g. `pull_request_target`, `workflow_dispatch`, `schedule`, or absent), or whose `job_workflow_ref` is not `promote.yml` on the default branch of the same repository (or is absent)
- WHEN `/promote` is called for the merged event (any `source_branch`)
- THEN `PERMISSION_DENIED` is returned and nothing is promoted

#### Scenario: Default branch unchanged
- GIVEN a token minted on the default branch
- WHEN `/promote` receives `source_branch` = default branch, with or without `pr_number`
- THEN the default-branch session is promoted as before

#### Scenario: Bad token
- GIVEN a wrong-audience, wrong-issuer, expired, badly signed or claim-less token
- WHEN posting `/promote`
- THEN `PERMISSION_DENIED` is returned

### Requirement: Composition root and workflow

`src/index.ts` MUST use the real `GithubOidcAuthenticator` when `PROMOTE_OIDC_DEV_BYPASS=false`, keeping the dev branch and its production guard, and config MUST require `GITHUB_OIDC_AUDIENCE` on the real path. `.github/workflows/promote.yml` MUST trigger on push to the default branch, request an OIDC token (`permissions: id-token: write`, configured audience) and `POST /promote` with a body matching the `.strict()` schema, with no long-lived secrets. The push job MUST look up the PR associated with the pushed commit (`GITHUB_TOKEN`, `pull-requests: read`); if exactly one merged, same-repository PR targets the default branch and its `merge_commit_sha` is the pushed commit, the body MUST carry its head branch as `source_branch` and its `pr_number`; otherwise the body MUST carry the default branch. Untrusted values (head branch name) MUST be passed through env and `jq --arg` only.

Source: promote-oidc; feature-branch-promotion

#### Scenario: Workflow auth
- GIVEN a merged PR
- WHEN the workflow runs
- THEN it authenticates with OIDC only and promotes the PR's head branch session

#### Scenario: Direct push
- GIVEN a push to the default branch with no associated merged PR
- WHEN the workflow runs
- THEN it promotes the default-branch session

### Requirement: machine_credential provisioning

Provisioning MUST be documented as idempotent runbook SQL (`INSERT ... ON CONFLICT`) registering the repo principal to project mapping read by `findActiveMachineCredential`. `token_hash` (NOT NULL, unused on OIDC) MUST use the sentinel `'oidc:no-shared-secret'`. There MUST be no dev bypass in production and no seed on the pilot database.

Source: promote-oidc

#### Scenario: Re-running provisioning

- GIVEN the runbook SQL was applied
- WHEN applied again
- THEN no duplicate credential is created

### Requirement: Judge and OIDC bypass production guards

`JUDGE_STUB`, `BEDROCK_MODEL_ID`, `PROMOTE_OIDC_DEV_BYPASS` and `GITHUB_OIDC_AUDIENCE` MUST use `z.enum(['true','false']).transform` (not `z.coerce.boolean`). `superRefine` MUST make `JUDGE_STUB=true` and `PROMOTE_OIDC_DEV_BYPASS=true` impossible when `NODE_ENV=production` and MUST require `BEDROCK_MODEL_ID` and `GITHUB_OIDC_AUDIENCE` when their stub is off. The composition root MUST add a `NODE_ENV !== 'production'` defense-in-depth check.

Source: promotion-pipeline

#### Scenario: Judge stub in production

- GIVEN `NODE_ENV=production` and `JUDGE_STUB=true`
- WHEN configuration is loaded
- THEN loading fails

#### Scenario: OIDC bypass in production

- GIVEN `NODE_ENV=production` and `PROMOTE_OIDC_DEV_BYPASS=true`
- WHEN configuration is loaded
- THEN loading fails

### Requirement: Dev seed demonstrates promotion

The dev seed MUST add a dev `machine_credential`, an open `main` session and one pending `add` item so that `POST /promote` under the dev harness demonstrates the full vertical.

Source: promotion-pipeline

#### Scenario: Demo promote

- GIVEN the seeded dev database
- WHEN posting `/promote` for the seeded repo and default branch
- THEN the seeded item is promoted

### Requirement: Promotion test coverage

Unit tests MUST cover deterministic and fail-closed judges, the `PromoteService` state machine, the config guard matrix and both OIDC authenticators. DB-gated integration tests (skipped without `DATABASE_URL`) MUST cover each op end to end, dedup, stale conflict, supersede relation idempotency, quarantine, terminal transitions and idempotent re-run. A supertest of `POST /promote` with dev stubs MUST cover success, repo-claim mismatch, no session and unknown repo.

Source: promotion-pipeline

#### Scenario: Suite green

- GIVEN no `DATABASE_URL`
- WHEN running `pnpm test`
- THEN unit and supertest cases pass and DB-gated tests skip

### Requirement: Structured judge verdict

Every judge evaluation SHALL produce and persist a verdict (`accepted` | `uncertain` | `rejected`), a determining criterion (`specificity`, `duplication`, `contradiction`, `grounding`, `confidence`, `security_second_layer`), a confidence in [0, 1] and a justification. The judge MUST receive as context up to 3 similar active memories of the same project, delimited as untrusted data. A related memory reference MUST only be stored if it belongs to that context.

Source: judge-structured-verdict

#### Scenario: Accepted with confidence at or above threshold is applied (HU-06.1)

- GIVEN a staged `gotcha` whose judge result is `accepted` with confidence ≥ `JUDGE_CONFIDENCE_THRESHOLD`
- WHEN the branch is promoted
- THEN a memory is created with version 1, the author's identity and origin branch/PR
- AND the staging item stores verdict, criterion, confidence and reason

#### Scenario: Duplicate of an active memory is rejected with reference (HU-06.2)

- GIVEN an active memory and a staged item the judge marks `rejected`/`duplication` with that memory as related
- WHEN promoted
- THEN the item is quarantined with reason `duplicate_content` and `related_memory_id` set to the active memory
- AND no memory is created

#### Scenario: Contradiction or low confidence is queued (HU-06.3)

- GIVEN a judge result `uncertain`/`contradiction`, or `accepted` with confidence below the threshold
- WHEN promoted
- THEN the item is not applied, stays in the review queue, and the low-confidence case is stored as `uncertain`/`confidence`
- AND the project's tech lead is notified (`review_enqueued`)

#### Scenario: Mandatory review even when accepted (HU-06.4)

- GIVEN an item of a type listed in `MANDATORY_REVIEW_TYPES`, or any `supersede`/`deprecate` operation, that the judge accepts above threshold
- WHEN promoted
- THEN it is not applied, `mandatory_review` is true and it is in the review queue
- AND `review_enqueued` is notified

#### Scenario: Second-layer security rejection blocks (HU-06.5)

- GIVEN the judge returns `rejected`/`security_second_layer`
- WHEN promoted
- THEN the item is quarantined with its content redacted, `sanitize_flags.leak` is true and `leak_detected` is notified

#### Scenario: Model unavailable never auto-accepts (HU-06.6)

- GIVEN the model times out, errors, or returns output that is not valid JSON per the schema
- WHEN the item is evaluated
- THEN the result is `uncertain`/`confidence` and the item is queued, never applied

### Requirement: Validation pipeline before the judge

Before the judge, promotion SHALL run on every non-terminal item, in order: credential detection, embedded-instruction detection, and personal-data masking. Format, required fields and size limits stay enforced as today.

Source: judge-structured-verdict

#### Scenario: Credential → quarantine, leak flag and alert (HU-05)

- GIVEN a staged item containing a credential pattern
- WHEN promoted
- THEN it is quarantined with reason `secret_detected` and redacted content, `sanitize_flags.leak` is true and `leak_detected` is notified
- AND the secret value is never logged

#### Scenario: Embedded instructions → quarantine (HU-05)

- GIVEN a staged item whose text contains instructions aimed at agents (e.g. "ignore previous instructions", "ignorá las reglas", "you are now")
- WHEN promoted
- THEN it is quarantined with reason `embedded_instructions` and the judge is not called

#### Scenario: Personal data is masked, not blocked (HU-05)

- GIVEN a staged item containing an email, a phone number or a DNI/CUIT
- WHEN promoted
- THEN those spans are replaced by `[EMAIL]`, `[PHONE]` or `[ID]` before the judge and in the stored memory
- AND `sanitize_flags.pii` lists the categories and the item continues through the pipeline

#### Scenario: Previously uncertain items are sanitized too

- GIVEN an item persisted as `uncertain` at capture
- WHEN promoted
- THEN the pipeline runs on it before it is queued

### Requirement: Notifier

The system SHALL notify the project's tech lead through a `Notifier` seam whenever an item enters the review queue (`review_enqueued`) or a leak is detected (`leak_detected`). The demo implementation MUST write a structured log carrying project id, event and category names only, never content.

Source: judge-structured-verdict

#### Scenario: Notification payload has no content

- GIVEN a leak is detected
- WHEN the notifier is called
- THEN the log entry contains the event, project id and categories, and no title, body or matched text

### Requirement: PR closed without merge discards staged units (HU-04.2)

`POST /promote` SHALL accept `event: "merged" | "closed_unmerged"` (default `merged`). For `closed_unmerged`, with the same OIDC authentication and a required `pr_number`, the open staging session of the repository and source branch SHALL be marked `abandoned` and its non-promoted items discarded, in one transaction. The `merged` path keeps its default-branch restriction unchanged.

Source: web-api-and-review-queue

#### Scenario: Closed PR discards
- GIVEN an open session on `feature/x` with 3 staged items
- WHEN `/promote` receives `{event:"closed_unmerged", source_branch:"feature/x", pr_number:7}`
- THEN the session is `abandoned`, its items are gone, and the response reports 3 discarded

#### Scenario: Repeated close is a no-op
- GIVEN the session was already abandoned
- WHEN the same event arrives again
- THEN the response is `no_op` and nothing changes

#### Scenario: Merged path with a feature branch
- GIVEN a merge event whose `source_branch` is not the default branch
- WHEN `/promote` is called without `event`, with a default-branch token from `promote.yml` on push and `pr_number`
- THEN the feature session is promoted (feature-branch-promotion)


### Requirement: Stale target revision goes to human review (HU-11.3)

An `amend`, `supersede` or `deprecate` whose `target_revision` is no longer current SHALL be stored as `uncertain` with criterion `stale_target` and `mandatory_review = true`, both at capture and at promotion, and SHALL NOT be quarantined.

Source: judge-structured-verdict (supersedes promotion-pipeline stale_target quarantine)

#### Scenario: Stale target at promotion

- GIVEN an `amend` captured against revision N, and the memory has since moved to N+1
- WHEN promoted
- THEN no quarantine row is created, the item is `uncertain`/`stale_target` with `mandatory_review` true, and `review_enqueued` is notified

### Requirement: Judge configuration

`JUDGE_CONFIDENCE_THRESHOLD` (0..1, default 0.80), `MANDATORY_REVIEW_TYPES` (CSV of memory types, default `decision,constraint,domain_rule`) and `JUDGE_STUB_CONFIDENCE` (0..1, default 0.9) SHALL be validated at startup. `JUDGE_STUB_VERDICT` is removed. The deterministic judge MUST remain impossible under `NODE_ENV=production`.

Source: judge-structured-verdict (supersedes promotion-pipeline `JUDGE_STUB_VERDICT`)

#### Scenario: Invalid threshold fails fast

- GIVEN `JUDGE_CONFIDENCE_THRESHOLD=1.5`
- WHEN configuration loads
- THEN startup fails with an explicit error

#### Scenario: Unknown type in mandatory list fails fast

- GIVEN `MANDATORY_REVIEW_TYPES=decision,foo`
- WHEN configuration loads
- THEN startup fails with an explicit error

### Requirement: Revalidation deadline on apply

Source: memory-lifecycle

Every apply path (promotion, review approval, quarantine restore) SHALL set `revalidate_at = now() + REVALIDATION_DAYS` for non-`outcome` memories and NULL for `outcome`, including amends.

#### Scenario: Amend resets the deadline
- GIVEN an active memory with a deadline 10 days away
- WHEN an amend is applied
- THEN its deadline becomes now + 60 days

### Requirement: Human-approved single-item mode

Source: direct-memory-management

The single-item pipeline SHALL support a human-approved mode, reachable only from the project_admin direct-management API, in which review-queue routing is replaced by apply (with `approved_by` = the approver and provenance `web_ui`), while pipeline quarantine, judge rejections and apply-time duplicate quarantine still apply, and a stale target returns a conflict instead of being queued. Automatic applies set `approved_by` to NULL (approver of the current revision).

#### Scenario: Agents cannot use human approval
- GIVEN the MCP tools and the `/promote` endpoint
- WHEN they process items
- THEN the human-approved mode is never enabled

## History

| Requirement | Source | Superseded by |
|---|---|---|
| `GithubOidcAuthenticator` is a fail-closed skeleton that always throws `PERMISSION_DENIED` | promotion-pipeline | promote-oidc (real JWKS verification, kept above) |
| `BedrockJudge` model call deferred (`invokeModel` stub) | promotion-pipeline | real-bedrock-clients (real Converse judge; see `bedrock-clients`) |
| Stale target found at promotion is quarantined with reason `stale_target` | promotion-pipeline | judge-structured-verdict (`uncertain`/`stale_target`, mandatory review, no quarantine) |
| `DeterministicJudge` returns constant `JUDGE_STUB_VERDICT`; `JUDGE_STUB_VERDICT` env var | promotion-pipeline | judge-structured-verdict (heuristic rules, `JUDGE_STUB_CONFIDENCE`) |
