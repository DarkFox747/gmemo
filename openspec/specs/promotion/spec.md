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

Any verification failure (wrong audience, wrong issuer, expired or not-yet-valid, bad signature, missing `repository` or `ref`) MUST result in `PERMISSION_DENIED` with no enumerable detail. The `/promote` handler MUST also assert `source_branch == repo.default_branch`, in addition to `ref == source_branch` and `repo == principal.repository`.

Source: promote-oidc

#### Scenario: Feature-branch run

- GIVEN a valid OIDC token on a branch that is not the default
- WHEN posting `/promote`
- THEN `PERMISSION_DENIED` is returned

#### Scenario: Bad token

- GIVEN a wrong-audience, wrong-issuer, expired, badly signed or claim-less token
- WHEN verifying
- THEN `PERMISSION_DENIED` is returned

### Requirement: Composition root and workflow

`src/index.ts` MUST use the real `GithubOidcAuthenticator` when `PROMOTE_OIDC_DEV_BYPASS=false`, keeping the dev branch and its production guard, and config MUST require `GITHUB_OIDC_AUDIENCE` on the real path. `.github/workflows/promote.yml` MUST trigger on PR merge to the default branch, request an OIDC token (`permissions: id-token: write`, configured audience) and `POST /promote` with a body matching the `.strict()` schema, with no long-lived secrets.

Source: promote-oidc

#### Scenario: Workflow auth

- GIVEN a merged PR
- WHEN the workflow runs
- THEN it authenticates with OIDC only

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

## MODIFIED Requirements

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

## History

| Requirement | Source | Superseded by |
|---|---|---|
| `GithubOidcAuthenticator` is a fail-closed skeleton that always throws `PERMISSION_DENIED` | promotion-pipeline | promote-oidc (real JWKS verification, kept above) |
| `BedrockJudge` model call deferred (`invokeModel` stub) | promotion-pipeline | real-bedrock-clients (real Converse judge; see `bedrock-clients`) |
| Stale target found at promotion is quarantined with reason `stale_target` | promotion-pipeline | judge-structured-verdict (`uncertain`/`stale_target`, mandatory review, no quarantine) |
| `DeterministicJudge` returns constant `JUDGE_STUB_VERDICT`; `JUDGE_STUB_VERDICT` env var | promotion-pipeline | judge-structured-verdict (heuristic rules, `JUDGE_STUB_CONFIDENCE`) |
