# Design: Direct memory management (C5) — HU-13

## Technical Approach

C5 adds no new write path. A direct web write is turned into a one-item staging session and goes through the same per-item pipeline as agent promotions: C3's `PromoteService.promoteItem`, then C1's sanitize → judge → route, then C2's shared `applyOpInTxn` (with C4's `$13`). The only new behaviour lives in that pipeline. A `humanApproved` option on `promoteItem` replaces queueing (R5–R7) with apply, because the project_admin's confirm *is* the human review. It never touches sanitize-stage quarantine (S1–S3) or judge rejection (R2–R4).

The change has five parts:

1. **Shared evaluation (`src/promote/evaluate.ts`)**. `evaluateCandidate` runs sanitize → judge context → judge → normalize → `routeDecision` and never writes. `PromoteService.processItem` and the preview both call it, so the preview and the confirm run literally the same code.
2. **Apply core parameters (`src/db/promotionRepository.ts`)**. `ApplyContext` gains `provenance` and `approvedBy`. They become `$14`/`$15` in the two memory statements that C4 already extends with `$13` (`INSERT_MEMORY_SQL`, `UPDATE_MEMORY_AMEND_SQL`). No SQL is forked. C2's separate approver UPDATE (R7) is folded into the same parameter.
3. **Web session (`src/db/stagingRepository.ts`)**. `createSingleItemSession` inserts the session and the item in one transaction. Branch is `web/<userId>/<sessionId>`, `opened_by` and `author_identity` are the actor's subject (server-side), and the repo is re-asserted against the project.
4. **Read model (`src/db/memoryAdminRepository.ts`)**. List (it replaces C4's LIST and extends its contract), detail and revisions. All tenant-scoped, keyset cursor, `websearch_to_tsquery`.
5. **Service and routes**. `src/memory/directMemoryService.ts` orchestrates, and C4's `src/http/api/memoryRoutes.ts` gains four routes on C2's admin-only nested router. Audit goes through `recordApi`.

**Prerequisites**: C1 is in `src/`, including the SEC M-1 guard (`applyAccepted(…, mandatoryTypes)` → `review_required`). **C2, C3 and C4 must be implemented before C5.** C5 depends on `applyOpInTxn`, `abandonOpenSession`, `findMemoryRefs`, `recordApi`, the error mapper, `promoteItem`, `ItemResult`, `QuarantineRepository.findVisible`, `classifyQuarantine`, `isSecretFree`, migration 0009 `web_ui`, C4's `$13`, `memoryRoutes.ts` and `MemoryListQuery`.

**Alignment notes for the orchestrator (spec deltas / upstream contract changes):**
- **Session branch**: `web/<userId>/<sessionId>` instead of the literal `web/<userId>` from D1. With the bare prefix, two concurrent writes by the same tech lead on the same repo (or a double-click) would share one `ux_session_open` slot. An agent on a git branch literally named `web/<uuid>` could also occupy it. The ULID suffix gives exactly one session per write, as D1 intends ("one-item session per write, mirrors C3 `restore/<id>`"). The `web/<userId>` prefix is kept for identification.
- **Preview "no row written anywhere"**: preview writes no domain row: nothing in memory, memory_revision, memory_relation, staging_session, staging_item or quarantine, and no notification is sent. It does write **one `access_log` read row**, because the project convention is that every read is audited (C2). Tests assert exactly that.
- **C4 list contract changes** (binding from proposal item 1):
  - The default `status` becomes `active` (was `pending_revalidation`). The default `limit` becomes 20 (max stays 200).
  - The order is `updated_at DESC, id DESC` (was `revalidate_at ASC`).
  - The response gains `nextCursor`.
  - `LifecycleRepository.listMemories` / `LifecycleService.list` move to `MemoryAdminRepository` / `DirectMemoryService`. One read model for browsing, and lifecycle stays writes-only. C4's list tests are updated to match.
- **`approved_by` on automatic amend**: it now means "approver of the current revision". An automatic (promotion) amend writes `approved_by = NULL`. Before, a stale approver survived the content change. C2's approve passes its reviewer through `ApplyContext.approvedBy`, and its R7 statement is removed. The behaviour is the same for C2, and only one writer of `approved_by` is left.
- **Persist order in promotion**: because `evaluateCandidate` has no writes, `persistMasked` (S4) now runs *after* the judge instead of before. The judge input is identical (masked content), and persistence still happens before any state write. The only observable difference is that a session-level `hash_conflict` now costs one judge call. The promotion spec ("masked before the judge and in the stored memory") still holds.
- **Apply-time duplicate (A3) in human-approved mode still quarantines** (`duplicate_content`). This is the strict reading of "never skips quarantine", and it adds no special case.
- **Judge unavailable under human approval**: fail-closed `uncertain` is applied on confirm. This is the same as C2's human approve of a fail-closed item: the human is the review. Sanitize (S1–S3) still runs.
- `provenance` already has an unused `manual_ui` value (0002). C5 writes `web_ui` (C4 0009), as the proposal fixes.
- Spec deltas needed: `promotion` (human-approved mode, `approved_by` semantics, persist order), `memory-lifecycle` (list defaults/order/cursor), plus the new `direct-memory` capability that already exists.

## Architecture Decisions

### Decision 1: `humanApproved` is an option on `promoteItem` that only changes the queue branch and the stale branch

**Choice** (`src/promote/promoteService.ts`, extending C3's contract):

```ts
/** The project_admin who confirmed a direct web write. app_user.id (AdminActor.userId). */
export interface HumanApproval { approverUserId: string }
export interface PromoteItemOptions { humanApproved?: HumanApproval }

export type ItemResult =                                   // C3 union + one variant
  | { outcome: 'applied'; memoryId: string | null; deduped: boolean }
  | { outcome: 'queued'; itemId: string }
  | { outcome: 'quarantined'; itemId: string; quarantineId: string | null }
  | { outcome: 'skipped'; itemId: string }
  /** humanApproved ONLY: the target moved between the caller's check and apply. Nothing written;
   *  the session is left open for the caller to abandon. */
  | { outcome: 'conflict'; itemId: string; code: 'target_changed' };

export interface PromoteServiceLike {
  promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome>;              // unchanged
  promoteItem(sessionId: string, itemId: string, origin: ItemOrigin,
              opts?: PromoteItemOptions): Promise<ItemResult>;
}
```

`promoteItem` builds `ApplyContext` from `origin` plus the option:
- With `humanApproved`: `provenance: 'web_ui'`, `approvedBy: opts.humanApproved.approverUserId`.
- Without it: `'pr_reviewed'`, `null`.

It then calls the private `processItem(item, ctx, humanApproved: boolean)`. `promote()` always passes `false`.

Exact routing effect inside `processItem` when `humanApproved = true` (references are C1's tables):

| Stage | Automatic (today) | humanApproved |
|---|---|---|
| S1 `sanitize_failed`, S2 `secret_detected`, S3 `embedded_instructions` | quarantine (+ `leak_detected` for S2) | **identical** |
| S4 PII mask → `persistMasked`; `hash_conflict` → quarantine `duplicate_content` | as is | **identical** |
| R2 security_second_layer, R3 duplication, R4 specificity | quarantine (+ leak for R2) | **identical** |
| R5 uncertain, R6 accepted < threshold, R7 accepted ≥ threshold + mandatory | `recordDecision` + `review_enqueued` → queued | **apply**. No `recordDecision` and no notification: the item stays `pending`, which is never in C2's queue predicate, so a failure between steps can never surface a direct write in the review queue |
| R8 accepted, not mandatory | `recordDecision` → apply | identical |
| R1 stale_target, or a `rejected` verdict routed to queue (both impossible for a freshly judged item after `normalizeJudgeResult`) | queued | **not overridden** → `queued`. The caller treats it as an internal error (Decision 6) |
| apply → `applied` / `already` | applied | identical |
| apply → `stale` (A2) | `recordDecision(stale_target)` + notify → queued | **`{outcome:'conflict', code:'target_changed'}`**. No write and no notification. The session is not finalized |
| apply → `review_required` (SEC M-1) | mandatory queue | unreachable (see below). If it happens: `logger.warn` with the item id → `conflict target_changed` |
| apply → `duplicate` (A3) | quarantine `duplicate_content` | **identical** |

- **M-1 under human approval**: the apply is called with `mandatoryTypes = NO_MANDATORY_TYPES` (an empty frozen `Set`). A mandatory **target type** is exactly what the human approval covers. The **type-change** half of the guard is kept, and the service rejects a type change before the write (Decision 6). Amend bumps `current_revision`, so a target whose type changed after the check is caught first by the stale check.
- **Session close**: `promoteItem` finalizes with C3's `terminalStatus` for `applied`/`quarantined`/`queued`/`skipped`. For `conflict` it returns without finalizing, and the caller abandons the session (Decision 6). The only caller that can receive `conflict` is the only caller that passes the option.
- **Surfacing `target_changed`**: the new `ItemResult` variant is produced only on the `humanApproved` branch. Automatic mode keeps queueing stale items (HU-11.3, unchanged). C3's `QuarantineService` switch gains a `conflict` arm that does `logger.error` + `AppError(INTERNAL)`. It is unreachable because restore never passes the option, and TypeScript enforces exhaustiveness.

**Why it is unreachable from MCP and promotion** (each point is backed by a test, see Test Strategy):
1. **Call sites**:
   - `/promote` calls only `promote()`, which hard-codes `humanApproved = false`.
   - C3 restore calls `promoteItem(s, i, origin)` without options.
   - MCP handlers receive `HandlerDeps`, which has no `PromoteService`, and no file under `src/mcp/` imports `promoteService`.
2. **Construction**: `HumanApproval.approverUserId` is built only in `DirectMemoryService` from an `AdminActor`. Only C2's `projectAdmin` middleware produces an `AdminActor` (Gate 2 + `role = project_admin`).
3. **Architecture test**: a source scan asserts that the identifiers `humanApproved` / `HumanApproval` appear only in `src/promote/promoteService.ts` and `src/memory/directMemoryService.ts` (plus `src/memory/types.ts` for the import).

**Alternatives considered**:
- (a) A separate `applyDirect` service method that calls `applyAccepted` without routing. Rejected: it skips R2–R4 and would be a second pipeline (proposal risk).
- (b) Insert the item as already `accepted`/approved and let the pipeline apply it. Rejected: the C1 non-pending path reuses the persisted decision and never judges, so R2–R4 would be skipped.
- (c) Record the true judge decision before apply. Rejected: an `uncertain` row is in C2's queue predicate until apply commits, and a crash would leave a direct write queued.
- (d) Queue stale items in human mode too. Rejected: the spec requires a 409 and "nothing changes".

**Rationale**: The diff to the pipeline is two `if` branches, both guarded by one boolean that only one caller can set. Every security stage runs unchanged.

**Reversible**: Yes. The option is additive. Removing it restores C3's contract.

### Decision 2: Provenance and approver are `ApplyContext` fields that become `$14`/`$15` in the two existing memory statements

**Choice** (`src/db/promotionRepository.ts`):

```ts
export type MemoryProvenance = 'pr_reviewed' | 'web_ui';
export interface ApplyContext {
  projectId: string; repoId: string; originBranch: string; originPr: number | null; sessionId: string;
  provenance: MemoryProvenance;      // NEW — required, so every construction site is flagged by tsc
  approvedBy: string | null;         // NEW — app_user.id of the human approver; null = automatic
}
```

Final SQL. C4's text is unchanged, and `$14`/`$15` are appended:

```sql
-- INSERT_MEMORY_SQL (A1 add, S2 supersede)
-- $1 project_id $2 repo_id $3 type $4 title $5 summary $6 body $7 fields $8 author_identity
-- $9 content_hash $10 origin_branch $11 origin_pr $12 embedding $13 revalidation_days
-- $14 provenance $15 approved_by
INSERT INTO memory
  (project_id, repo_id, type, title, summary, body, fields,
   status, provenance, author_identity, content_hash, current_revision,
   origin_branch, origin_pr, embedding, revalidate_at, approved_by)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
        'active', $14::provenance, $8, $9, 1, $10, $11, $12::vector,
        CASE WHEN $3::memory_type = 'outcome' THEN NULL
             ELSE now() + make_interval(days => $13::int) END,
        $15::uuid)
ON CONFLICT (project_id, content_hash) DO NOTHING
RETURNING id
```

```sql
-- UPDATE_MEMORY_AMEND_SQL (M2)
-- $1 title $2 summary $3 body $4 fields $5 type $6 content_hash $7 author_identity
-- $8 origin_branch $9 origin_pr $10 memory_id $11 project_id $12 embedding
-- $13 revalidation_days $14 provenance $15 approved_by
UPDATE memory
SET title = $1, summary = $2, body = $3, fields = $4::jsonb, type = $5,
    content_hash = $6, author_identity = $7, provenance = $14::provenance,
    approved_by = $15::uuid,
    origin_branch = $8, origin_pr = $9, embedding = $12::vector,
    revalidate_at = CASE WHEN $5::memory_type = 'outcome' THEN NULL
                         ELSE now() + make_interval(days => $13::int) END,
    current_revision = current_revision + 1, updated_at = now()
WHERE id = $10 AND project_id = $11
```

- The three call sites inside `applyOpInTxn` (A1, S2, M2) append `ctx.provenance, ctx.approvedBy`.
- `content_tsv` stays out of every column list. It is GENERATED, so an amend regenerates it.
- The amend's `embedding = $12` is the vector `processItem` just computed from the new text (fail-soft: null on embedder error, as documented by the exploration).
- **Dedup** (`ON CONFLICT DO NOTHING`) leaves the existing row's provenance and approver untouched. This is exactly C2's R7 rule "when !deduped".
- **C2 approve**: `approveReviewItem` builds its `ctx` with `provenance: 'pr_reviewed', approvedBy: input.reviewerUserId` (C2 decision: human approval goes in `approved_by`, not provenance), and **its R7 `UPDATE memory SET approved_by` is deleted**. C2 should also pass `NO_MANDATORY_TYPES` to the M-1 check, because the approval is human. That is C2's own concern and is noted here for coherence.
- Construction sites that must set the two fields:
  - `PromoteService.promote` → `'pr_reviewed', null`
  - `promoteItem` → per option
  - C2 `approveReviewItem` / `rejectReviewItem`. The values are unused by quarantine, but the type is shared.
  - `tests/db/promotion.integration.test.ts` literals.
- Deprecate (D1–D3), `UPDATE_MEMORY_SUPERSEDED_SQL` and quarantine ignore both fields.

**Alternatives considered**:
- (a) A `provenance` constructor option, as C4 did with `revalidationDays`. Rejected: provenance is per call, not process config.
- (b) Keep C2's R7 and add a C5 approver UPDATE. Rejected: two writers of one column and an extra round trip, and amend would still keep a stale approver after an automatic change.
- (c) `approved_by = COALESCE($15, approved_by)`. Rejected: after an automatic amend, the new content would show an approver who never saw it.

**Rationale**: The parameter rides with the existing per-item metadata (`originBranch`, `originPr`). One statement per op still writes the row. Promotion, review approve, restore and direct writes stay byte-identical except for the bound values.

**Reversible**: Yes. Internal interface. Reverting means binding the literals back.

### Decision 3: `evaluateCandidate` — one read-only evaluation shared by promotion and preview

**Choice** (`src/promote/evaluate.ts`, new; it absorbs the private `judgeItem` and its logging):

```ts
export interface CandidateContent { title: string; summary: string; body: string; fields: Record<string, unknown> }
export interface Candidate extends CandidateContent, RoutingItem {    // RoutingItem: op, type, mandatory_review, target_type
  target_memory_id: string | null;
}
export interface EvaluateDeps {
  contextSource: Pick<PromotionRepository, 'findJudgeContext'>;     // the ONLY repository capability: a read
  judge: Judge;
  routing: RoutingConfig;
}
export interface EvaluateOptions {
  projectId: string;
  /** Decision rebuilt from persisted columns (non-pending item); null → judge now. */
  persisted: RoutingDecision | null;
  /** Log correlation only: item id, or 'preview'. Never content. */
  logId: string;
}
export type CandidateEvaluation =
  | { kind: 'blocked'; sanitize: SanitizeResult & { block: SanitizeBlock } }
  | { kind: 'routed'; sanitize: SanitizeResult; content: CandidateContent;   // masked when PII found
      context: readonly JudgeContextItem[]; decision: RoutingDecision; judged: boolean; route: RouteOutcome };

export async function evaluateCandidate(c: Candidate, deps: EvaluateDeps, o: EvaluateOptions): Promise<CandidateEvaluation>;
```

Algorithm:
1. `s = sanitizeItem(c)`. If `s.block` → `blocked`. The judge is never called (promotion spec: "the judge is not called").
2. `content = s.masked ?? c`.
3. If `o.persisted` → `decision = o.persisted`, `context = []`, `judged = false`.
4. Otherwise:
   - `findJudgeContext(projectId, content, c.target_memory_id)`. A throw → `failClosed('judge_context_unavailable')` + warn.
   - `judge.evaluate({op, type, ...content}, context)`. A throw → `failClosed('judge_unavailable')` + warn.
   - `normalizeJudgeResult(r, context, { itemId: o.logId })`.
5. `route = routeDecision(decision, c, routing)`. It is pure.

`evaluateCandidate` never throws on judge or context failure. A DB error elsewhere is impossible because it only reads.

`PromoteService.processItem` becomes:
1. rejected → skipped.
2. `wasQueued`.
3. `ev = evaluateCandidate(fetched, …, { persisted: pending ? null : fromPersisted(fetched), logId: fetched.id })`.
4. `flags = mergeFlags(fetched.sanitize_flags, ev.sanitize.flags)`.
5. `blocked` → today's quarantine block, unchanged.
6. If `ev.sanitize.masked` → `persistMasked` (`hash_conflict` → quarantine `duplicate_content`, unchanged).
7. Switch on `ev.route` with the Decision 1 overrides.

**No-write guarantee for preview**: preview passes only `EvaluateDeps`, whose single repository capability is a `Pick<…, 'findJudgeContext'>` read. The type system therefore forbids a write. A unit test also asserts that a recording fake sees zero mutating calls.

**Alternatives considered**:
- (a) Preview re-implements the chain (sanitize + context + judge + route). Rejected: preview and confirm could drift, which defeats the purpose of a preview.
- (b) A callback hook to persist the mask before the judge. Rejected: cleverness for an ordering that changes no judge input (alignment note).
- (c) Dry-run the real pipeline inside a rolled-back transaction. Rejected: the pipeline uses per-item transactions on separate pool clients, and notifications would fire.

**Rationale**: One function is the definition of "what the pipeline thinks of this unit". The proposal names this extraction.

**Reversible**: Yes. Internal refactor.

### Decision 4: Web session = one transaction, `web/<userId>/<sessionId>`, repo re-asserted, author from the server

**Choice** (`src/db/stagingRepository.ts`):

```ts
export interface SingleItemSessionInput {
  sessionId: string;          // ulid() from the caller
  projectId: string; repoId: string;
  branch: string;             // `web/${userId}/${sessionId}`
  openedBy: string;           // actor.actorId (idp_subject), same meaning as remember / C3 restore
  item: InsertStagingItemParams;
}
createSingleItemSession(i: SingleItemSessionInput): Promise<{ sessionId: string; itemId: string }>;
```

```sql
-- S1 (inside BEGIN)  $1 id $2 project_id $3 repo_id $4 branch $5 opened_by
-- Plain insert (NO ON CONFLICT): the branch embeds the fresh ULID, so ux_session_open cannot collide;
-- a 23505 would be a bug and propagates. The SELECT re-asserts repo ∈ project (defence in depth).
INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, last_activity_at, expires_at)
SELECT $1, $2, r.id, $4, 'open', $5, now(), now() + interval '7 days'
FROM repo r WHERE r.id = $3 AND r.project_id = $2
-- rowCount 0 → ROLLBACK, AppError(NOT_FOUND)
-- S2: the existing INSERT_STAGING_ITEM_SQL constant (no new item SQL). A fresh session cannot dedup;
-- 0 RETURNING rows → ROLLBACK + AppError(INTERNAL) (defensive).
```

- The item is `op` add|amend, `judgeState: 'pending'`, `judgeCriterion: null`, `mandatoryReview: false`, `judgeReason: null`.
- `contentHash = computeContentHash({op, type, title, summary, body, fields, target})`, the same canonical hash as remember.
- `targetMemoryId`/`targetRevision` = path id / `expectedRevision` for amend, null for add.
- **`authorIdentity = actor.actorId`**, never taken from the body (zod `.strict()` rejects any extra key).
- Repo choice (D2), `MemoryAdminRepository.findProjectRepoId(projectId, repoId | null)`:

```sql
-- $1 project_id  $2 repo_id|null
SELECT id FROM repo WHERE project_id = $1 AND ($2::uuid IS NULL OR id = $2)
ORDER BY created_at ASC, id ASC LIMIT 1
```

  A foreign or unknown `repoId`, or a project without repos → `not_found` → 404. The same opacity as any foreign id.
- **Collision analysis**:
  - `ux_session_open` is keyed on (project, repo, branch) and the branch contains a new ULID, so a double-click or two tabs give two sessions.
  - `/promote` merged only handles the default branch, and `closed_unmerged` refuses the default branch and needs a PR-bound ref, so neither ever touches a `web/…` session.
  - A git branch literally named `web/<uuid>/<ulid>` cannot be predicted before the insert.
  - `promoteItem` processes only the inserted item id.
- **Close after processing**: `promoteItem` finalizes the session on terminal outcomes. On `conflict`, an unexpected outcome or a throw, the service calls C2's `abandonOpenSession(sessionId, projectId)`, which in one transaction marks the session `abandoned` and deletes non-promoted items. No `web/` session stays `open` (Decision 6).

**Alternatives considered**:
- (a) Reuse `findOrCreateOpenSession` with `web/<userId>`. Rejected: the upsert shares a session across concurrent writes, and the second write's `promoteItem` would run in an already finalized session.
- (b) Put the insert in `MemoryAdminRepository` or `PromotionRepository`. Rejected: `StagingRepository` is the staging write seam. C3's `claimForRestore` keeps its own insert because it is fused with a quarantine row lock, and folding the two is a possible follow-up.

**Rationale**: It mirrors C3's one-item session with a single transaction, so there is never a session without its item.

**Reversible**: Yes. Rows follow the normal staging lifecycle (C3 sweep).

**Residual risk (documented)**: a credential in a direct write is in `staging_item` in clear between S2's insert and the pipeline's `quarantineItem`, which overwrites the row with redacted content (C1/C3). If the pipeline throws, the abandon deletes the row. If both fail, the row stays and both errors are logged with ids. The staging row's `content_hash` stays the hash of the original (C3's documented residual). The HU-13.4 test runs C3's `information_schema` secret scan after a direct confirm.

### Decision 5: Read model — `MemoryAdminRepository` (list replaces C4's LIST; detail; revisions)

**Choice** (`src/db/memoryAdminRepository.ts`). Every statement carries `project_id = $1`. `memory_revision` has no project column, so it is scoped through `JOIN memory`.

```sql
-- LIST  $1 project_id $2 status $3 type|null $4 q|null $5 cursor_ts|null $6 cursor_id|null $7 limit+1
SELECT m.id, m.type, m.title, m.summary, m.status, m.current_revision, m.provenance,
       m.origin_branch, m.origin_pr, m.revalidate_at, m.updated_at,
       to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_key
FROM memory m
WHERE m.project_id = $1
  AND m.status = $2::memory_status
  AND ($3::memory_type IS NULL OR m.type = $3::memory_type)
  AND ($4::text IS NULL OR m.content_tsv @@ websearch_to_tsquery('english', $4))
  AND ($5::timestamptz IS NULL OR (m.updated_at, m.id) < ($5::timestamptz, $6::uuid))
ORDER BY m.updated_at DESC, m.id DESC
LIMIT $7                     -- rows > limit → nextCursor from the last kept row; extra row dropped

-- DETAIL  $1 project_id $2 memory_id   (any status)
SELECT m.id, m.type, m.title, m.summary, m.body, m.fields, m.status, m.current_revision,
       m.provenance, m.author_identity,
       COALESCE(au.display_name, au.email, m.author_identity) AS author,
       m.approved_by, COALESCE(ap.display_name, ap.email) AS approver,
       m.repo_id, r.slug AS repo_slug, m.origin_branch, m.origin_pr,
       m.created_at, m.updated_at, m.revalidate_at, m.retired_reason
FROM memory m
LEFT JOIN app_user au ON au.idp_subject = m.author_identity
LEFT JOIN app_user ap ON ap.id = m.approved_by
LEFT JOIN repo r      ON r.id = m.repo_id AND r.project_id = m.project_id
WHERE m.project_id = $1 AND m.id = $2

-- REVISIONS  $1 project_id $2 memory_id $3 limit+1 (100 + 1)
SELECT mr.revision_no, mr.op, mr.type, mr.title, mr.summary, mr.body, mr.fields,
       COALESCE(u.display_name, u.email, mr.author_identity) AS author, mr.created_at
FROM memory_revision mr
JOIN memory m ON m.id = mr.memory_id AND m.project_id = $1
LEFT JOIN app_user u ON u.idp_subject = mr.author_identity
WHERE mr.memory_id = $2
ORDER BY mr.revision_no DESC
LIMIT $3
```

```ts
export type MemoryStatus = 'active' | 'superseded' | 'deprecated' | 'pending_revalidation';  // moved from C4
export interface MemoryListFilter { status: MemoryStatus; type: MemoryType | null; q: string | null;
                                    cursor: string | null; limit: number }
export interface MemoryListRow { id; type; title; summary; status; current_revision; provenance: string;
  origin_branch; origin_pr; revalidate_at: Date | null; updated_at: Date }                 // C4 row + provenance
export interface MemoryAdminRepository {
  listMemories(projectId: string, f: MemoryListFilter): Promise<{ rows: MemoryListRow[]; nextCursor: string | null }>;
  findMemory(projectId: string, memoryId: string): Promise<MemoryDetailRow | null>;
  listRevisions(projectId: string, memoryId: string): Promise<{ rows: MemoryRevisionRow[]; truncated: boolean }>;
  findProjectRepoId(projectId: string, repoId: string | null): Promise<string | null>;
}
export function encodeMemoryListCursor(c: { updatedKey: string; id: string }): string;  // exported for the fake
export function decodeMemoryListCursor(s: string): { updatedKey: string; id: string };
```

- **Cursor**: `base64url("<updated_key>|<uuid>")`. `updated_key` is produced by SQL with microseconds, so the keyset is exact. A JS `Date` would truncate to milliseconds and skip rows. Decoding checks `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$` and the UUID regex (the `decodeRecallCursor` pattern). On failure it throws **`AppError(INVALID_REQUEST)`** → 400. `INVALID_REFERENCE` would map to 404 on REST.
- **`q`**: trimmed, 1..200 chars, always a bind parameter. `websearch_to_tsquery` never raises a syntax error. A query of only stopwords matches nothing, which is documented. `q` is a **filter**, not a ranking: ranking by `ts_rank_cd` would need a float keyset (recall's pattern) and would make the order depend on the query. A browse UI wants stable recency.
- **Drift**: `updated_at` changes on amend, retire or supersede. A row edited mid-pagination moves to page 1. This is acceptable for a human browse view and documented.
- **Indexes**: none added (no schema change in C5). `ix_memory_proj_status` plus pilot volumes. `(project_id, status, updated_at DESC, id DESC)` is the documented follow-up.
- `findMemory` serves the detail route, the preview and PUT target checks, and the post-write response. One query, one mapper.
- C4 `PgLifecycleRepository.listMemories` and `LifecycleService.list` are **deleted**, and `MemoryStatus` / `MemoryListRow` move here (C4's types file re-imports them).

**Alternatives considered**:
- (a) Widen C4's `listMemories` in place. Rejected: browsing (list + detail + revisions) would be split across two repositories, and the lifecycle repository would no longer be writes-only.
- (b) Offset pagination. Rejected: unstable under inserts, and it costs O(offset).
- (c) Read revisions through `MemoryRepository`. Rejected: that is the agent-facing, active-only read seam (contract v1 exposes no history).

**Reversible**: Yes.

### Decision 6: `DirectMemoryService` — validation order, target checks, outcome mapping

**Choice** (`src/memory/types.ts` holds the contracts; `src/memory/directMemoryService.ts` holds the implementation):

```ts
export interface UnitInput { type: MemoryType; title: string; summary: string; body: string;
                             fields: Record<string, unknown>; repoId: string | null }
export type PreviewInput = (UnitInput & { op: 'add' })
                         | (UnitInput & { op: 'amend'; targetMemoryId: string; expectedRevision: number });
export type AmendInput = UnitInput & { expectedRevision: number };
export type PreviewOutcome = { kind: 'ok'; dto: PreviewResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' } | { kind: 'conflict'; code: ConflictCode } | { kind: 'invalid' };
export type WriteOutcome = { kind: 'done'; dto: DirectWriteResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' } | { kind: 'conflict'; code: ConflictCode } | { kind: 'invalid' };
export interface DirectMemoryServiceLike {
  list(projectId: string, q: MemoryListQueryInput): Promise<MemoryListDto>;
  get(projectId: string, memoryId: string): Promise<MemoryDetailDto | null>;
  preview(actor: AdminActor, projectId: string, input: PreviewInput): Promise<PreviewOutcome>;
  create(actor: AdminActor, projectId: string, input: UnitInput): Promise<WriteOutcome>;
  amend(actor: AdminActor, projectId: string, memoryId: string, input: AmendInput): Promise<WriteOutcome>;
}
export interface DirectMemoryServiceDeps {
  memoryAdminRepository: MemoryAdminRepository;
  stagingRepository: Pick<StagingRepository, 'createSingleItemSession'>;
  promotionRepository: Pick<PromotionRepository, 'findJudgeContext' | 'abandonOpenSession'>;
  promoteService: Pick<PromoteServiceLike, 'promoteItem'>;
  reviewQueueRepository: Pick<ReviewQueueRepository, 'findMemoryRefs'>;   // C2, related ref
  quarantineRepository: Pick<QuarantineRepository, 'findVisible'>;        // C3, reason code
  judge: Judge;
  routing: RoutingConfig;                       // the SAME instance PromoteService uses
}
```

**Shared pre-checks** (preview, create and amend, in this order; nothing is written before they pass):
1. `repoId = findProjectRepoId(projectId, input.repoId)`. Null → `not_found`.
2. Amend only: `t = findMemory(projectId, targetId)`.
   - null → `not_found`.
   - `t.status !== 'active'` → `conflict target_inactive`. A `pending_revalidation` target is confirmed first through C4.
   - `t.current_revision !== expectedRevision` → `conflict target_changed`.
   - `t.type !== input.type` → `invalid`. This mirrors remember's SEC M-1 rule: an op may not change its target's type.

**preview**:
1. Run the pre-checks.
2. Run `evaluateCandidate({ ...unit, op, target_memory_id, target_type: t?.type ?? null, mandatory_review: false }, { contextSource: promotionRepository, judge, routing }, { projectId, persisted: null, logId: 'preview' })`.
3. For a `related` id: `findMemoryRefs(projectId, [id])`.
4. Map the result (DTO below).

There is no notification: a preview is not persisted, so `leak_detected` fires only on confirm.

**create / amend**:
1. Run the pre-checks.
2. Build the item, `sessionId = ulid()`, `branch = web/${actor.userId}/${sessionId}`, and call `createSingleItemSession` (Decision 4).
3. `r = promoteItem(sessionId, itemId, { tenant: {projectId, repoId, branch}, originBranch: branch, originPr: null }, { humanApproved: { approverUserId: actor.userId } })`.
4. If step 3 **throws**:
   - `logger.error('[direct] pipeline failed', { sessionId, itemId, errorName })`.
   - Call `abandonOpenSession`. If that fails too, log it as a separate error.
   - Rethrow → 500.
5. Map `r`:

| `ItemResult` | Action | HTTP |
|---|---|---|
| `applied` (memoryId non-null) | `findMemory` + `listRevisions` → `{ outcome:'applied', deduped, memory: MemoryDetailDto }` | 200 |
| `quarantined` (quarantineId non-null) | `findVisible(projectId, {isAdmin:true, subject: actor.actorId}, quarantineId)` → `{ outcome:'quarantined', quarantineId, reasonCode, criterion }` | 200 |
| `conflict` | `abandonOpenSession(sessionId, projectId)` → `conflict target_changed` | 409 |
| `queued`, `skipped`, `applied` with null id, `quarantined` with null id | `logger.error` with ids → abandon → `AppError(INTERNAL)` | 500 |

- An `add` whose exact content hash already exists → `applied, deduped: true` with the **existing** memory (the promotion rule). Its provenance and approver stay untouched (Decision 2).
- A judge `rejected` verdict, secret, instructions or A3 duplicate → 200 `quarantined`. The confirm never overrides these (HU-13.4).

**Alternatives considered**:
- (a) Skip the pre-check and rely on apply's stale check. Rejected: every stale click would create and abandon a session and spend a judge call, and the type and status checks are needed anyway.
- (b) Return 201 for applied. Rejected: one status with an `outcome` discriminator for both terminal outcomes follows C3's restore (a quarantined confirm creates no memory).

**Rationale**: A thin orchestrator over existing seams, unit-testable with fakes. Routes own the audit, as in C2/C3/C4.

**Reversible**: Yes.

### Decision 7: Routes, zod schemas, error mapping and audit

**Choice**: C4's `makeMemoryRoutes` (`src/http/api/memoryRoutes.ts`) takes `{ lifecycleService, directMemoryService, auditLogger }`. It is mounted on C2's nested `/v1/projects/:projectId` router behind `projectAdmin`.

| Method + path | Chain (after apiAuth → projectAdmin) | Success | Audit (`recordApi`) |
|---|---|---|---|
| `GET /memories` (C4 route, rewired) | zod query → `directMemoryService.list` | 200 `MemoryListDto` | `memories.list` `{status, type, resultCount, queryHash?}` |
| `POST /memories/preview` | zod → `preview` | 200 `PreviewResponseDto` | `memory.preview` `{type, memoryId?(target), previewOutcome}` → `read` |
| `GET /memories/:memoryId` | uuid → `get` (null → 404) | 200 `MemoryDetailDto` | `memory.read` `{memoryId}` |
| `POST /memories` | zod → `create` | 200 `DirectWriteResponseDto` | `memory.create` `{memoryId?, itemId, outcome, quarantineId?, deduped?}` → `update` |
| `PUT /memories/:memoryId` | uuid → zod → `amend` | 200 `DirectWriteResponseDto` | `memory.amend` (same detail; `memoryId` = path) → `update` |

```ts
const fieldsRefine = (u: { type: MemoryType; fields: Record<string, unknown> }, ctx: z.RefinementCtx) => {
  if (JSON.stringify(u.fields).length > 2000) ctx.addIssue({ code: 'custom', message: 'invalid' });
  try { assertValidFields(u.type, u.fields); }           // single source of the per-type key policy
  catch (e) { if (e instanceof AppError) ctx.addIssue({ code: 'custom', message: 'invalid' }); else throw e; }
};
const Unit = {
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(120), summary: z.string().min(1).max(200), body: z.string().min(1).max(2000),
  fields: z.record(z.unknown()).default({}),
  repoId: z.string().uuid().optional(),
};                                                        // budgets identical to rememberInputShape / DB CHECKs
const Revision = z.number().int().positive();             // a JSON number; "3", 0, -1, 1.5 → 400
export const CreateBody = z.object({ ...Unit, confirm: z.literal(true) }).strict().superRefine(fieldsRefine);
export const AmendBody  = z.object({ ...Unit, expectedRevision: Revision, confirm: z.literal(true) })
  .strict().superRefine(fieldsRefine);
export const PreviewBody = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), ...Unit }).strict(),
  z.object({ op: z.literal('amend'), ...Unit, targetMemoryId: z.string().uuid(), expectedRevision: Revision }).strict(),
]).superRefine(fieldsRefine);
export const MemoryListQuery = z.object({                 // C4's schema, widened (C4 contract note)
  status: z.enum(['active', 'pending_revalidation', 'superseded', 'deprecated']).default('active'),
  type: z.enum(MEMORY_TYPES).optional(),
  q: z.string().trim().max(200).optional(),               // '' after trim → treated as absent
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
}).strict();                                              // repeated params (arrays) / unknown keys → 400
```

- `assertValidFields` throws `INVALID_REFERENCE`, which C2's mapper turns into **404**. The refinement turns it into a 400 for the admin, and only `AppError` is converted (anything else propagates).
- `confirm` must be the literal `true`. Missing, `false` or `"true"` → 400.
- **Validation order** (C2 rule): apiAuth → projectAdmin → uuid (`z.string().uuid()` on `:memoryId`; failure → `NOT_FOUND`) → zod (failure → `INVALID_REQUEST`) → service. A contributor, viewer or non-member never reaches validation and gets the byte-identical `{"error":"Not found"}`, so validation cannot be used as an oracle.
- **Mapping**:
  - `not_found` → `AppError(NOT_FOUND)` → 404.
  - `invalid` → `AppError(INVALID_REQUEST)` → 400.
  - `conflict` → `res.status(409).json({ error: 'Conflict', code })` (C2's 409 writer, `ConflictCode` unchanged).
  - A malformed cursor → `INVALID_REQUEST` → 400.
- **Express order**: `POST /memories/preview` and `POST /memories/retire-by-pr` (C4) are declared before any `/:memoryId` handler. Neither collides with the two-segment C4 paths.
- **Audit**:
  - The audit runs after success only (200), never on 400/404/409.
  - `ApiAction` gains `'memory.read' | 'memory.preview' | 'memory.create' | 'memory.amend'`.
  - C4's `WRITE_API_ACTIONS` gains `'memory.create'` and `'memory.amend'` (→ `access_log.action = 'update'`). The others map to `read`.
  - `ApiAuditDetail` gains `queryHash?: string` and `previewOutcome?: 'apply' | 'quarantine'`. `RdsAuditLogger.recordApi` moves `detail.queryHash` into the existing `access_log.query_hash` column and removes it from `detail`.
  - `queryHash = sha256Hex(q.trim().toLowerCase())`, the same normalisation as the MCP recall wrapper. Raw `q`, titles, bodies and judge text are never in the audit.
- Every `/api` response is already `Cache-Control: no-store` (C2), so preview text and judge reasons are not cached.
- The preview is rate-limited by C2's `/api` limiter (D3), and no new limiter is added.

**DTOs** (`src/http/api/types.ts`, camelCase, ISO strings):

```ts
interface MemoryListItemDto { id; type: MemoryType; title; summary; status: MemoryStatus; version: number;
  provenance: string; originBranch: string | null; originPr: number | null; revalidateAt: string | null; updatedAt: string }
interface MemoryListDto { items: MemoryListItemDto[]; nextCursor: string | null; truncated: boolean } // truncated = nextCursor !== null (C4 compat)
interface MemoryListQueryInput { status: MemoryStatus; type: MemoryType | null; q: string | null; cursor: string | null; limit: number }
interface MemoryRevisionDto { revisionNo: number; op: 'add'|'amend'|'supersede'|'deprecate'; type: MemoryType;
  title; summary; body; fields: Record<string, unknown>; author: string; createdAt: string }
interface MemoryDetailDto { id; type; title; summary; body; fields; status: MemoryStatus; version: number;
  provenance: string; author: string; approver: { userId: string; name: string | null } | null;
  repo: { id: string; slug: string | null } | null; originBranch; originPr; createdAt; updatedAt;
  revalidateAt: string | null; retiredReason: string | null;
  revisions: MemoryRevisionDto[]; revisionsTruncated: boolean }          // newest first, max 100
interface PreviewResponseDto {
  outcome: 'apply' | 'quarantine';                                         // what confirm would do
  withoutApproval: 'apply' | 'queue_uncertain' | 'queue_mandatory' | 'quarantine';  // what agent promotion would do
  pipeline: { blocked: boolean; reasonCode: 'secret_detected' | 'embedded_instructions' | 'sanitize_failed' | null;
              findings: { secrets?: string[]; injection?: string[]; pii?: string[] } };   // categories only
  preview: { title: string; summary: string; body: string; fields: Record<string, unknown> } | null;
  judge: null | { verdict: Verdict; criterion: JudgeCriterion; confidence: number; threshold: number;
                  reason: string; related: MemoryRefDto | null };          // null when sanitize blocked
  quarantineReasonCode: QuarantineReasonCode | null;                       // classifyQuarantine(...) when outcome = quarantine
}
type DirectWriteResponseDto =
  | { outcome: 'applied'; deduped: boolean; memory: MemoryDetailDto }
  | { outcome: 'quarantined'; quarantineId: string; reasonCode: QuarantineReasonCode | null;
      criterion: QuarantineCriterion | null };
```

How the preview DTO is filled:
- **`preview`** is `ev.content` (PII-masked) or, when blocked, `ev.sanitize.masked ?? input`. It is returned **only if `isSecretFree(content)`** (C3), otherwise `null`. S1 → `null`. With C3, S2 content is span-redacted, so the tech lead normally sees `[REDACTADO]` in place, and a secret is never echoed.
- **`judge.reason`** is the normalized reason. For `rejected/security_second_layer` it is replaced by the literal `'security_second_layer'` (C1 R2: model text is never surfaced).
- **`outcome`**: `quarantine` iff the result is blocked or the route is quarantine. Otherwise `apply`.
- **`withoutApproval`** comes from the route kind and queue.
- **`threshold`** = `routing.confidenceThreshold`.
- **`related`** = `findMemoryRefs` result with status and version.

**Rationale**: It reuses C2's chain, mapper, 409 writer and audit, and C4's route file, write-action set and list schema. Only unions and DTOs grow.

**Reversible**: Yes.

## Data Flow

```
Web (C7) ─▶ /api ─▶ apiLimiter ─▶ apiAuth ─▶ /v1/projects/:pid ─▶ projectAdmin ──(not admin / bad uuid)──▶ 404
  GET  /memories?status&type&q&cursor ─▶ zod ─▶ DirectMemoryService.list ─▶ LIST (keyset, websearch) ─▶ recordApi(read, queryHash)
  GET  /memories/:id ─▶ uuid ─▶ findMemory + listRevisions ─null─▶ 404 ─▶ recordApi(read)
  POST /memories/preview ─▶ zod(+assertValidFields) ─▶ pre-checks (repo, target: 404/409/400)
        ─▶ evaluateCandidate  [reads only: findJudgeContext]
             sanitize(S1–S4) ─blocked─▶ quarantine-preview (no judge)
             └▶ context ─▶ judge ─▶ normalize ─▶ routeDecision(R1–R8)
        ─▶ findMemoryRefs(related) ─▶ 200 PreviewResponseDto ─▶ recordApi(read)      (no domain write, no notify)
  POST /memories | PUT /memories/:id ─▶ zod(confirm:true, expectedRevision) ─▶ same pre-checks
        ─▶ createSingleItemSession  [1 txn: session web/<uid>/<ulid> (repo∈project) + item pending, author=actor]
        ─▶ promoteItem(session, item, origin, { humanApproved: { approverUserId } })
             processItem(humanApproved=true):
               evaluateCandidate ─blocked─▶ quarantineItem (+leak_detected)            ─┐
               persistMasked (PII)                                                      │
               route quarantine R2–R4 ─▶ quarantineItem (+leak R2)                      ├─▶ finalizeSession
               route queue R5–R7 ─▶ (no recordDecision) ─┐                              │
               route apply R8 ─▶ recordDecision ─────────┴▶ embed ─▶ applyAccepted(NO_MANDATORY_TYPES)
                    applyOpInTxn: INSERT/UPDATE memory ($13 revalidate, $14 'web_ui', $15 approver)
                                  + memory_revision (author=actor) ; tsv regenerated; embedding set
                    applied ─────────────────────────────────────────────────────────────┘
                    stale ─▶ ItemResult conflict (session left open)
                    duplicate ─▶ quarantineItem
        ─▶ applied ─▶ findMemory+revisions ─▶ 200 {applied, memory}          ─▶ recordApi(update)
           quarantined ─▶ findVisible ─▶ 200 {quarantined, reasonCode}       ─▶ recordApi(update)
           conflict ─▶ abandonOpenSession (session abandoned, item deleted) ─▶ 409 {Conflict, target_changed}
           throw / unexpected ─▶ log ids ─▶ abandonOpenSession ─▶ 500
  POST /memories/:id/retire ─▶ C4 (unchanged; HU-13.3)

/promote ─▶ promote() ─▶ processItem(humanApproved=false)     C3 restore ─▶ promoteItem(no opts)     MCP ─▶ no PromoteService
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `HumanApproval`, `PromoteItemOptions`, `PromoteServiceLike.promoteItem(…, opts?)`, `ItemResult` (+`conflict`) | type / interface | `src/promote/promoteService.ts` | `src/memory/directMemoryService.ts`, `src/quarantine/quarantineService.ts`, `tests/auth/fakes.ts`, `tests/memory/directFakes.ts` |
| `Candidate`, `CandidateContent`, `EvaluateDeps`, `EvaluateOptions`, `CandidateEvaluation`, `evaluateCandidate` | type / func | `src/promote/evaluate.ts` | `src/promote/promoteService.ts`, `src/memory/directMemoryService.ts` |
| `MemoryProvenance`, `ApplyContext.provenance`, `ApplyContext.approvedBy`, `NO_MANDATORY_TYPES` | type / const | `src/db/promotionRepository.ts` | `src/promote/promoteService.ts`, C2 `approveReviewItem` (same file), `tests/db/promotion.integration.test.ts` |
| `INSERT_MEMORY_SQL` / `UPDATE_MEMORY_AMEND_SQL` `$14`, `$15` | SQL params | `src/db/promotionRepository.ts` | `applyOpInTxn` (promotion, C2 approve, C3 restore, C5) |
| `SingleItemSessionInput`, `StagingRepository.createSingleItemSession` | type / interface | `src/db/stagingRepository.ts` | `src/memory/directMemoryService.ts`, `tests/staging/fakes.ts` |
| `MemoryStatus`, `MemoryListFilter`, `MemoryListRow`, `MemoryDetailRow`, `MemoryRevisionRow`, `MemoryAdminRepository`, `PgMemoryAdminRepository`, `encode/decodeMemoryListCursor` | type / interface / class / func | `src/db/memoryAdminRepository.ts` | `src/memory/directMemoryService.ts`, `src/http/api/types.ts`, `src/lifecycle/types.ts`, `src/index.ts`, `tests/memory/directFakes.ts` |
| `UnitInput`, `PreviewInput`, `AmendInput`, `PreviewOutcome`, `WriteOutcome`, `DirectMemoryServiceLike`, `DirectMemoryServiceDeps` | type / interface | `src/memory/types.ts` | `src/memory/directMemoryService.ts`, `src/http/api/memoryRoutes.ts`, `src/http/api/types.ts`, `src/mcp/context.ts`, `tests/auth/fakes.ts` |
| `DirectMemoryService` | class | `src/memory/directMemoryService.ts` | `src/index.ts` |
| `MemoryListQueryInput` (widened), `MemoryListItemDto` (+provenance), `MemoryListDto` (+nextCursor), `MemoryDetailDto`, `MemoryRevisionDto`, `PreviewResponseDto`, `DirectWriteResponseDto`; `ApiRouterDeps.directMemoryService` | type | `src/http/api/types.ts` | `src/memory/directMemoryService.ts`, `src/http/api/memoryRoutes.ts`, `src/http/api/router.ts`, `packages/web` (C7) |
| `ApiAction` += `memory.read`, `memory.preview`, `memory.create`, `memory.amend`; `ApiAuditDetail` += `queryHash`, `previewOutcome`; `AppServices.directMemoryService` | type | `src/mcp/context.ts` | `src/http/api/memoryRoutes.ts`, `src/auth/auditLogger.ts`, `src/index.ts` |
| `MemoryListQuery` (widened), `CreateBody`, `AmendBody`, `PreviewBody` | zod schema | `src/http/api/memoryRoutes.ts` | `tests/http/api/directMemory.test.ts` |
| `GET /memories` (extended), `POST /memories/preview`, `GET /memories/:memoryId`, `POST /memories`, `PUT /memories/:memoryId` under `/api/v1/projects/:projectId` | endpoint | `src/http/api/memoryRoutes.ts` | `packages/web` (C7), `scripts/smoke.ts` |

## File Changes

Precondition: C2, C3 and C4 are implemented. Batches:
- **A** runs first.
- **B** and **D** run in parallel after A. Their file sets are disjoint.
- **C** needs B. **E** needs C and D. **F** needs E. **G** needs F.
- **H** (docs) can run with G.

No file appears in two batches. `tsc` is green only after F, because the contracts declared in A are implemented later (same pattern as C2/C3).

| File | Action | Description |
|------|--------|-------------|
| **A — Contracts** | | |
| `src/memory/types.ts` | Create | `UnitInput`, `PreviewInput`, `AmendInput`, `PreviewOutcome`, `WriteOutcome`, `DirectMemoryServiceLike`, `DirectMemoryServiceDeps` |
| `src/db/memoryAdminRepository.ts` | Create | Types only in A: `MemoryStatus` (moved from C4), `MemoryListFilter`, row types, `MemoryAdminRepository` |
| `src/mcp/context.ts` | Modify | `ApiAction` + 4; `ApiAuditDetail` + `queryHash`, `previewOutcome`; `AppServices.directMemoryService` |
| `src/http/api/types.ts` | Modify | Widened list DTOs, detail/revision/preview/write DTOs, `ApiRouterDeps.directMemoryService`; `MemoryStatus` import from the new repository file |
| `tests/auth/fakes.ts` | Modify | `makeStubAuthServices`: `directMemoryService` stub; `promoteService.promoteItem` stub accepts `opts` |
| **B — Apply core + web session** | | |
| `src/db/promotionRepository.ts` | Modify | `MemoryProvenance`, `ApplyContext.provenance/approvedBy`, `NO_MANDATORY_TYPES`; `$14`/`$15` in the two statements (Decision 2) at A1, S2 and M2; C2 `approveReviewItem` ctx with reviewer as `approvedBy` and R7 removed; reject ctx fields |
| `src/db/stagingRepository.ts` | Modify | `SingleItemSessionInput`, `createSingleItemSession` (session S1 SQL + existing item insert, one txn) |
| `tests/db/promotion.integration.test.ts` | Modify | Ctx literals; promotion add → `provenance='pr_reviewed'`, `approved_by NULL`; ctx `web_ui` + approver → both stored on add and amend; automatic amend over an approved memory → `approved_by NULL`; dedup leaves provenance/approver; supersede new row carries ctx values |
| `tests/db/review.integration.test.ts` | Modify | Approve still sets `approved_by` = reviewer (now via ctx); dedup approve leaves the existing approver |
| `tests/db/stagingRepository.integration.test.ts` | Modify | `createSingleItemSession`: session + item in one txn, branch stored, `opened_by`, item pending; foreign repo → NOT_FOUND and nothing inserted; two calls for the same user/repo → two open sessions (no `ux_session_open` collision) |
| `tests/staging/fakes.ts` | Modify | `createSingleItemSession` in the staging fake (records input) |
| **D — Read model** (parallel with B) | | |
| `src/db/memoryAdminRepository.ts` | Modify | `PgMemoryAdminRepository` (LIST, DETAIL, REVISIONS, REPO) + cursor codec |
| `src/db/lifecycleRepository.ts` | Modify | Remove `listMemories`, LIST SQL and `MemoryListRow`; import `MemoryStatus` from `memoryAdminRepository.ts` |
| `src/lifecycle/types.ts` | Modify | Remove `list` from `LifecycleServiceLike` |
| `src/lifecycle/lifecycleService.ts` | Modify | Remove `list` + list mapping |
| `tests/lifecycle/fakes.ts` | Modify | Drop list support |
| `tests/lifecycle/lifecycleService.test.ts` | Modify | Remove list cases (moved to E/D suites) |
| `tests/db/lifecycle.integration.test.ts` | Modify | Remove list cases (moved to `memoryAdmin.integration`) |
| `tests/db/memoryAdmin.integration.test.ts` | Create | DB-gated repository suite (see Test Strategy) |
| `tests/db/memoryListCursor.test.ts` | Create | Codec round-trip; malformed base64, missing `\|`, ms-only timestamp, non-UUID → `INVALID_REQUEST` |
| **C — Pipeline** (needs B) | | |
| `src/promote/evaluate.ts` | Create | `evaluateCandidate` and types (Decision 3); absorbs `judgeItem` |
| `src/promote/promoteService.ts` | Modify | `processItem` via `evaluateCandidate`; ctx provenance/approver; `humanApproved` branches (Decision 1); `HumanApproval`, `PromoteItemOptions`, `ItemResult.conflict`; `promoteItem(…, opts?)` |
| `src/quarantine/quarantineService.ts` | Modify | Exhaustive `conflict` arm → `logger.error` + `AppError(INTERNAL)` |
| `tests/promote/fakes.ts` | Modify | Record `ApplyContext` and the `mandatoryTypes` passed to `applyAccepted`; scripted `abandonOpenSession` |
| `tests/promote/evaluate.test.ts` | Create | Blocked → no context/judge call; PII → masked content judged; persisted decision → no judge call; context throw → `judge_context_unavailable`; judge throw → `judge_unavailable`; invalid pair normalized; recording repo sees only `findJudgeContext` |
| `tests/promote/promoteItemHumanApproved.test.ts` | Create | Decision 1 table row by row (see Test Strategy) |
| `tests/promote/humanApprovedReachability.test.ts` | Create | Source scan of `src/**/*.ts`: `humanApproved`/`HumanApproval` only in the three allowed files; no file under `src/mcp/` imports `promote/promoteService`; `src/http/promote.ts` never references `promoteItem` |
| `tests/promote/promoteService.test.ts` | Modify | `promote()` ctx = `pr_reviewed`/null; `hash_conflict` case now expects one judge call (persist order note); all other outcomes unchanged |
| `tests/promote/promoteVerdict.test.ts` | Modify | Only if an assertion depends on persist-before-judge ordering; PII-masked-before-judge assertion unchanged |
| `tests/quarantine/quarantineService.test.ts` | Modify | Scripted `conflict` → INTERNAL, logged |
| **E — Service** (needs C, D) | | |
| `src/memory/directMemoryService.ts` | Create | `DirectMemoryService` (Decision 6) |
| `tests/memory/directFakes.ts` | Create | `FakeMemoryAdminRepository` (shares the cursor codec), scripted `promoteItem`, recording staging/promotion fakes |
| `tests/memory/directMemoryService.test.ts` | Create | Pre-check order; preview mapping; write outcome mapping; abandon on conflict/throw/unexpected; approver = `actor.userId`; author/openedBy = `actor.actorId`; branch format |
| **F — Routes + audit** (needs E) | | |
| `src/http/api/memoryRoutes.ts` | Modify | Widened `MemoryListQuery`; `CreateBody`/`AmendBody`/`PreviewBody` + `fieldsRefine`; 4 new routes; list rewired to `directMemoryService`; 404/400/409 mapping; audit |
| `src/http/api/router.ts` | Modify | Pass `directMemoryService` into `makeMemoryRoutes` |
| `src/auth/auditLogger.ts` | Modify | `WRITE_API_ACTIONS` + `memory.create`, `memory.amend`; `recordApi` moves `detail.queryHash` → `query_hash` |
| `tests/auth/auditLogger.test.ts` | Modify | New action mapping; `queryHash` in the column and absent from detail; no content in detail |
| `tests/http/api/helpers.ts` | Modify | `makeApiTestApp` accepts a direct-memory service fake |
| `tests/http/api/memories.test.ts` | Modify | C4 list cases updated: default `active`, `limit` 20, `nextCursor`, `status=active` now 200 |
| `tests/http/api/directMemory.test.ts` | Create | Route validation, mapping, audit (see Test Strategy) |
| `tests/http/api/permissions.test.ts` | Modify | Opacity matrix rows for the 5 routes |
| **G — Composition + end to end** (needs F) | | |
| `src/index.ts` | Modify | `PgMemoryAdminRepository`; `DirectMemoryService` with the shared `routing` object, `judge`, repositories and `promoteService`; `AppServices.directMemoryService`; remove lifecycle list wiring |
| `tests/db/directMemory.integration.test.ts` | Create | Real PG + real `PromoteService` + `DeterministicJudge` + `StubEmbedder` + spy notifier (HU-13.1–5) |
| `tests/db/secretNeverPersisted.integration.test.ts` | Modify | Add the direct-confirm path to the seeded sentinels |
| `tests/mcp/humanApprovedUnreachable.test.ts` | Create | MCP `remember` (InMemoryTransport) with a spy `promoteService` in services → never called; staged item `pending` |
| `scripts/smoke.ts` | Modify | As `tl@demo.local`: preview a gotcha (200, `outcome:'apply'`), confirm add (200 `applied`, `provenance:'web_ui'`, version 1), `GET` detail shows 1 revision; `GET /memories?q=` finds it |
| **H — Docs** | | |
| `DEVELOPMENT.md` | Modify | curl examples for preview/create/amend/list/detail; human-approved semantics; `web/<userId>/<sessionId>` sessions |
| `openspec/project-map.yaml` | Modify | Direct memory management entry; `approved_by` semantics; `src/memory` |

## New Modules

None. `src/memory` holds two files (`types.ts`, `directMemoryService.ts`). It has no manifest and fewer than 10 source files.

## Test Strategy

The runner is vitest (`tests/**/*.test.ts`). DB-gated suites use the `*.integration.test.ts` skip-without-`DATABASE_URL` pattern with `runMigrations` in `beforeAll`. HTTP tests use supertest on C2's `makeApiTestApp`. End-to-end DB tests use the real `PromoteService` with `DeterministicJudge` (C1 rule table) and `StubEmbedder`.

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| **HU-13.1 preview then add** | integration (`directMemory.integration`) + unit (service, routes) | (1) Preview a valid `decision` → `outcome:'apply'`, `withoutApproval:'queue_mandatory'` (R7), judge `accepted/confidence 0.9`, `threshold` = config. (2) Confirm the same unit → 200 `applied`: memory `provenance='web_ui'`, `current_revision=1`, `approved_by` = TL `app_user.id`, `author_identity` = TL subject; revision 1 `op='add'` with author TL and `promoted_from_item` = the item; staging item `promoted_at` set; session `branch` matches `^web/<uid>/<ulid>$` and `status='promoted'`; `PgMemoryRepository.recall` returns it; no `review_enqueued` notification. (3) Hedge body (rule 6 → R6) and gotcha without artefact (rule 5 → R5) → applied. (4) Throwing judge (fail-closed uncertain) → applied. (5) Exact-hash re-add → `deduped:true`, existing id, approver untouched | Spec "Add a decision directly" |
| **Preview no-write** | integration + unit | Snapshot `count(*)` of memory, memory_revision, memory_relation, staging_session, staging_item, quarantine before and after preview (accept, duplicate, secret, injection cases) → unchanged; `access_log` gains exactly one `read` row with `detail.api='memory.preview'`; spy notifier never called (even for a secret). Unit: the recording repository sees only `findJudgeContext` | Spec "Preview reports a duplicate" |
| **Preview duplicate** | integration | Active memory with title "X"; preview add titled "x " → `judge.verdict 'rejected'`, `criterion 'duplication'`, `related = {id, status:'active', version}`, `outcome:'quarantine'`, `quarantineReasonCode:'duplicate_content'` | DeterministicJudge rule 3 |
| **Preview masking / secret echo** | unit + integration | Email in body → `preview.body` has `[EMAIL]`, `findings.pii:['email']`; AWS key → `pipeline.blocked`, `reasonCode:'secret_detected'`, `preview` shows `[REDACTADO]` where the key was, or `null`; the response body never contains the key (string search); R2 phrase → `judge.reason === 'security_second_layer'` | `isSecretFree` gate |
| **HU-13.2 amend** | integration | Memory v1 (add) → PUT with `expectedRevision:1` → v2: `memory_revision` rows 1 and 2 kept (row 1 unchanged); `provenance='web_ui'`, `approved_by` = TL; **`content_tsv @@ to_tsquery('english', '<new word>')` true and the old-only word false**; **`embedding` equals `StubEmbedder.embed(new title\nsummary\nbody)` and differs from v1's**; `revalidate_at` reset (C4); second amend → v3; `GET /memories/:id` → `version:3`, 3 revisions newest first with op, author and createdAt | Spec "History kept" |
| **Stale / conflicts** | integration + unit | (1) `expectedRevision:3` while current is 4 → 409 `{"error":"Conflict","code":"target_changed"}`, no session or item created, no judge call. (2) **Race**: a spy judge whose `evaluate` bumps `current_revision` by SQL, then returns accepted → apply `stale` → 409 `target_changed`; memory content unchanged; the session is `abandoned` and the item deleted; the item never appears in C2's queue; no notification. (3) Target deprecated / pending_revalidation → 409 `target_inactive`. (4) Type ≠ target type → 400. (5) Foreign-project or random `memoryId` → 404. (6) Amend colliding with another memory's content → 200 `quarantined`, `duplicate_content` (A3 kept) | Spec "Concurrent edit" |
| **HU-13.3 retire via C4** | integration | `web_ui` memory → C4 `POST /memories/:id/retire` → `deprecated`, revision `op='deprecate'` appended; detail shows 2 revisions and `retiredReason` | Regression only |
| **HU-13.4 same security treatment** | integration (+ `secretNeverPersisted`) | (1) Body with an AWS key → 200 `quarantined`, `reasonCode:'secret_detected'`, `criterion:'pipeline'`; the quarantine row is span-redacted; staging row content redacted and `sanitize_flags.leak = true`; spy notifier got `leak_detected`; **no memory row**; the C3 `information_schema` scan finds no key fragment in any table, including `access_log`. (2) "ignore previous instructions" → `embedded_instructions`, no leak notification. (3) DeterministicJudge rule 1 → R2 → whole redaction + leak. (4) Title "todo" → `judge_rejected`. (5) Pipeline throws after the insert (fake) → session abandoned, item row gone, 500, both ids logged | Spec "Credential in a direct add" |
| **HU-13.5 denial matrix** | unit (`permissions.test`) + integration | Contributor, viewer, non-member, other-project admin, platform_admin without membership, disabled user, malformed project uuid, random project uuid → byte-identical `{"error":"Not found"}` on all 5 routes (list, detail, preview, create, amend); a non-admin with an invalid body → 404, not 400; service spy never called; no `access_log` rows. DB: contributor `POST /memories` → no staging_session/staging_item/memory rows | Spec "Contributor denied" |
| **humanApproved unreachable** | unit + architecture + MCP | (1) Source scan (`humanApprovedReachability.test`). (2) `promote()` over a mandatory accepted item → queued (unchanged) and `applyAccepted` receives the configured mandatory types. (3) `promoteItem` without opts over the same item → queued; with opts → applied and `mandatoryTypes` is empty. (4) C3 restore of a `decision` → queued (existing C3 test still green). (5) MCP `remember` through InMemoryTransport with a spy `promoteService` → never called | Proposal risk "bypass for agents" |
| **promoteItem humanApproved (unit)** | unit | One case per Decision 1 row: S1/S2/S3 → quarantined (+leak on S2); R2/R3/R4 → quarantined; R5/R6/R7 → applied with **no** `recordDecision` and no `review_enqueued`; R8 → `recordDecision` then applied; apply `stale` → `conflict` and **no** `finalizeSession`; `review_required` → conflict + warn; `duplicate` → quarantined; ctx `provenance:'web_ui'`, `approvedBy` = approver | `FakePromotionRepository` |
| **evaluateCandidate** | unit | See batch C row; preview and processItem both call it (spy on the module export) | Pure-ish |
| **List** | integration (`memoryAdmin.integration`) + unit (routes) | Default `status=active` excludes the other 3 statuses; each status filter; `type` filter; `q` via websearch ("pool size" matches the body; `-pool` excludes it; quoted phrase works; stopword-only query → empty); 45 rows → pages of 20/20/5 with no gaps or duplicates when several rows share the same `updated_at` microsecond (forced by `UPDATE`); `nextCursor` null on the last page and `truncated` mirrors it; another project's rows never appear; malformed cursor / `limit=0` / `limit=201` / repeated `status` / unknown key → 400; audit `queryHash` = `sha256Hex(q)`, raw q absent | |
| **Detail / revisions** | integration + unit | Any status readable; `author` resolves the display name (falls back to subject); `approver` null for promotion memories; revisions of another project's memory never returned (JOIN guard); 101 revisions → 100 + `revisionsTruncated:true`; unknown/foreign → 404, audit `memory.read` once | |
| **Validation** | unit (`directMemory.test`) | `confirm` missing / false / `"true"` → 400; `expectedRevision` 0 / -1 / 1.5 / `"3"` → 400; title 121 / summary 201 / body 2001 / empty → 400; unknown `fields` key for the type (via `assertValidFields`) → **400, not 404**; fields JSON > 2000 → 400; extra key (`author_identity`) → 400; preview amend without `targetMemoryId` → 400; foreign `repoId` → 404; no `repoId` → the project's first repo by `created_at` is used | |
| **Apply core params** | integration (`promotion.integration`, `review.integration`) | See batch B rows | No SQL fork: same constants, bound values only |
| **Audit** | unit (`auditLogger.test`) + routes | `memory.create`/`memory.amend` → `update`; `memory.read`/`memory.preview`/`memories.list` → `read`; audit after 200 only (not on 400/404/409); detail never has title, body, q or judge reason | |
| **Smoke** | e2e (`pnpm smoke`) | Batch G row | Compose dev stubs |
