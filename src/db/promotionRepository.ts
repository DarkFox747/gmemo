/**
 * PromotionRepository — the single DB seam for the promotion pipeline.
 *
 * Mirrors stagingRepository.ts: top-level SQL constants, pg.Pool, parameterized
 * $N parameters only (no string concatenation), raw-row → typed-row, AppError on
 * unexpected DB failures.
 *
 * Per-item transaction granularity (Decision 1): every apply and quarantine
 * method opens its own BEGIN…COMMIT/ROLLBACK via pool.connect() so that a
 * single poisoned item cannot roll back already-committed items. The session
 * terminal-state UPDATE (finalizeSession) is a separate, final implicit txn.
 *
 * content_tsv is GENERATED ALWAYS — it is NEVER in any INSERT or UPDATE column
 * list. fields is always JSON.stringify(…)::jsonb (mirrors stagingRepository).
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { TenantContext } from '../mcp/context.js';
import type { DecisionCriterion, JudgeContextItem, Verdict } from '../judge/judge.js';
import { toVectorParam } from './vector.js';
import { computeContentHash, sha256Hex } from '../security/hash.js';
import { logger } from '../observability/logger.js';
import { QUEUED_PREDICATE } from './reviewQueueRepository.js';
import type { ConflictCode } from '../http/api/types.js';
import { classifyQuarantine, HUMAN_REVIEW_PREFIX } from '../quarantine/reason.js';
import type { QuarantineRedaction } from '../quarantine/reason.js';
import { WHOLE_REDACTION, isSecretFree } from '../security/secretRedact.js';

export type { ConflictCode };

// ---------------------------------------------------------------------------
// Types (exported for use by PromoteService and fakes)
// ---------------------------------------------------------------------------

/** Detector flags persisted on staging_item.sanitize_flags (categories only, never matched text). */
export interface SanitizeFlags {
  leak?: true;
  secrets?: string[];
  injection?: string[];
  pii?: string[];
}

/** Decision columns written in one statement per state transition. */
export interface PersistedDecision {
  verdict: Verdict;
  criterion: DecisionCriterion;
  confidence: number | null;
  reason: string;
  relatedMemoryId: string | null;
  mandatoryReview: boolean;
}

export interface QuarantineInput {
  /** quarantine.judge_reason (code). */
  reason: string;
  /**
   * How the snapshot is stored: 'none' as given; 'spans' as given after an
   * isSecretFree re-check (whole fallback); 'whole' = sentinel texts + fields {}.
   */
  redact: QuarantineRedaction;
  /** null on sanitize-stage quarantines (no judge decision exists). */
  decision: PersistedDecision | null;
  sanitizeFlags: SanitizeFlags;
}

/** Projection of a staging_item row returned by fetchPromotableItems. */
export interface PromotionItemRow {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  content_hash: string;
  target_memory_id: string | null;
  target_revision: number | null;
  /** Current type of the target memory (same project); null for add or a missing target. */
  target_type: MemoryType | null;
  judge_state: 'pending' | 'accepted' | 'uncertain' | 'rejected';
  judge_reason: string | null;
  judge_criterion: DecisionCriterion | null;
  judge_confidence: number | null;
  related_memory_id: string | null;
  mandatory_review: boolean;
  sanitize_flags: SanitizeFlags;
  author_identity: string;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

/** memory.provenance written by an apply: promotion/review vs direct web write (C5). */
export type MemoryProvenance = 'pr_reviewed' | 'web_ui';

/**
 * Tenant + promotion metadata threaded into every apply/quarantine call.
 * sessionId is required for quarantine origin_session_id.
 */
export interface ApplyContext {
  projectId: string;
  repoId: string;
  originBranch: string;
  originPr: number | null;
  sessionId: string;
  /** memory.provenance on add/supersede/amend ($14). Required so every construction site is explicit. */
  provenance: MemoryProvenance;
  /**
   * memory.approved_by ($15): app_user.id of the human approver of the written
   * revision; null = automatic apply (the approver of the current revision).
   */
  approvedBy: string | null;
}

export type ApplyResult =
  | { status: 'applied'; memoryId: string; deduped: boolean }
  | { status: 'stale' }
  | { status: 'duplicate' }
  | { status: 'already' } // promoted_at already set — idempotent no-op
  // Target type differs from the item type, or is a mandatory-review type:
  // nothing written, the item must go to the human review queue (SEC M-1).
  | { status: 'review_required' };

/** Outcome of the transaction-scoped apply core (no BEGIN/COMMIT/ROLLBACK inside). */
type OpResult =
  | { status: 'applied'; memoryId: string; deduped: boolean }
  | { status: 'stale' }
  | { status: 'duplicate' }
  | { status: 'review_required' };

export interface ReviewApproveInput {
  projectId: string;
  itemId: string;
  /** app_user.id of the project_admin approving. */
  reviewerUserId: string;
  /** Hash of the row the embedding was computed from. */
  expectedContentHash: string;
  embedding: number[] | null;
  /** The target revision the reviewer saw; null = not supplied. */
  targetRevision: number | null;
  markRelatedSuperseded: boolean;
}

export type ReviewApproveResult =
  | {
      status: 'approved';
      memoryId: string;
      deduped: boolean;
      rebasedFromRevision: number | null;
      rebasedToRevision: number | null;
      relatedSuperseded: boolean;
    }
  | { status: 'not_found' }
  | { status: 'conflict'; code: ConflictCode };

export interface ReviewRejectInput {
  projectId: string;
  itemId: string;
  reviewerUserId: string;
  /** Already validated, secret-scanned and PII-masked by the caller. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PromotionRepository {
  /** Finds the single open session for the given tenant + branch. */
  findOpenSessionId(tenant: TenantContext): Promise<string | null>;

  /**
   * Returns all promotable items for the session (promoted_at IS NULL).
   * projectId is JOINed against staging_session to re-assert tenant ownership
   * at fetch time (L3 defense-in-depth).
   */
  fetchPromotableItems(sessionId: string, projectId: string): Promise<PromotionItemRow[]>;

  /**
   * Up to 3 similar ACTIVE memories of the project (BM25 OR-query, no embedder).
   * excludeMemoryId (the item's target) is never returned. Empty tokens -> [].
   */
  findJudgeContext(
    projectId: string,
    text: { title: string; summary: string },
    excludeMemoryId: string | null,
  ): Promise<JudgeContextItem[]>;

  /**
   * Overwrites the staging row with PII-masked content and its recomputed hash.
   * Returns 'hash_conflict' when UNIQUE(session_id, content_hash) is violated.
   */
  persistMasked(
    itemId: string,
    content: { title: string; summary: string; body: string; fields: Record<string, unknown> },
    contentHash: string,
    flags: SanitizeFlags,
  ): Promise<'ok' | 'hash_conflict'>;

  /** Persists the structured judge decision on the item row (one write). */
  recordDecision(itemId: string, d: PersistedDecision, flags: SanitizeFlags): Promise<void>;

  /**
   * Applies one accepted item inside a per-item transaction.
   * FOR UPDATE lock + promoted_at IS NULL guard enforces first-writer-wins.
   * embedding is the pre-computed vector (null when the embed failed or op=deprecate).
   * mandatoryTypes: a target of one of these types (or of a type different from
   * the item's) is never mutated → { status: 'review_required' }.
   */
  applyAccepted(
    item: PromotionItemRow,
    ctx: ApplyContext,
    embedding: number[] | null,
    mandatoryTypes: ReadonlySet<MemoryType>,
  ): Promise<ApplyResult>;

  /**
   * Snapshots the item in quarantine (classified, with expiry) and marks it
   * terminal (rejected). The stored content (per q.redact) is written to both
   * the quarantine row and the staging row; a redacted quarantine row carries
   * the hash of the redacted content. Returns the new quarantine id, or null
   * (nothing written) when the item was applied or human-reviewed meanwhile.
   */
  quarantineItem(item: PromotionItemRow, ctx: ApplyContext, q: QuarantineInput): Promise<string | null>;

  /** Sets the session terminal status after all items have been processed. */
  finalizeSession(
    sessionId: string,
    status: 'promoted' | 'rejected' | 'partially_promoted',
  ): Promise<void>;

  /**
   * Human approval of a queued item (HU-07.2) in one transaction, reusing the
   * promotion apply SQL. First writer wins: a resolved item gives not_found.
   * judge_state is never touched.
   */
  approveReviewItem(i: ReviewApproveInput): Promise<ReviewApproveResult>;

  /** Human rejection (HU-07.3): quarantine 'human_review: <reason>' + review columns. */
  rejectReviewItem(i: ReviewRejectInput): Promise<'rejected' | 'not_found'>;

  /**
   * PR closed without merge (HU-04.2): marks the open session abandoned and
   * deletes its non-promoted items, in one transaction.
   */
  abandonOpenSession(
    sessionId: string,
    projectId: string,
  ): Promise<{ abandoned: boolean; discarded: number }>;
}

// ---------------------------------------------------------------------------
// SQL constants — parameterized, no string concatenation
// ---------------------------------------------------------------------------

// $1=project_id  $2=repo_id  $3=branch
const FIND_OPEN_SESSION_SQL = `
SELECT id FROM staging_session
WHERE project_id = $1 AND repo_id = $2 AND branch = $3 AND status = 'open'
`.trim();

// $1=session_id  $2=project_id (L3: JOIN re-asserts tenant; items from a
// different project's session cannot leak through even if session_id is known).
// target_type: the target memory's type, same project only (SEC M-1 routing).
const FETCH_PROMOTABLE_ITEMS_SQL = `
SELECT si.id, si.op, si.type, si.title, si.summary, si.body, si.fields, si.content_hash,
       si.target_memory_id, si.target_revision, tm.type AS target_type,
       si.judge_state, si.judge_reason,
       si.judge_criterion, si.judge_confidence, si.related_memory_id,
       si.mandatory_review, si.sanitize_flags,
       si.author_identity, si.promoted_at, si.promoted_memory_id
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
LEFT JOIN memory tm ON tm.id = si.target_memory_id AND tm.project_id = ss.project_id
WHERE si.session_id = $1 AND si.promoted_at IS NULL AND si.reviewed_at IS NULL
  AND ss.project_id = $2
ORDER BY si.created_at ASC
`.trim();

// $1=judge_state $2=judge_reason $3=judge_criterion $4=judge_confidence
// $5=related_memory_id $6=mandatory_review $7=sanitize_flags(jsonb) $8=item_id
const RECORD_DECISION_SQL = `
UPDATE staging_item
SET judge_state = $1, judge_reason = $2, judge_criterion = $3, judge_confidence = $4,
    related_memory_id = $5, mandatory_review = $6, sanitize_flags = $7::jsonb
WHERE id = $8 AND promoted_at IS NULL AND reviewed_at IS NULL
`.trim();

// $1=title $2=summary $3=body $4=fields(jsonb) $5=content_hash $6=sanitize_flags(jsonb) $7=item_id
const PERSIST_MASKED_SQL = `
UPDATE staging_item
SET title = $1, summary = $2, body = $3, fields = $4::jsonb,
    content_hash = $5, sanitize_flags = $6::jsonb
WHERE id = $7 AND promoted_at IS NULL AND reviewed_at IS NULL
`.trim();

// $1=websearch query string  $2=project_id  $3=exclude memory id | null
const FIND_JUDGE_CONTEXT_SQL = `
SELECT m.id, m.type, m.title, m.summary
FROM memory m, websearch_to_tsquery('english', $1) q
WHERE m.project_id = $2 AND m.status = 'active' AND m.content_tsv @@ q
  AND ($3::uuid IS NULL OR m.id <> $3)
ORDER BY ts_rank_cd(m.content_tsv, q) DESC, m.id DESC
LIMIT 3
`.trim();

// S0: Lock + idempotency guard. A human-reviewed row is never applied by
// promotion (reviewed_at set → 'already'). $1=item_id
const LOCK_ITEM_SQL = `
SELECT promoted_at, reviewed_at FROM staging_item WHERE id = $1 FOR UPDATE
`.trim();

// A1/S2: Insert authoritative memory (add and supersede ops).
// content_tsv OMITTED — GENERATED ALWAYS.
// $1=project_id $2=repo_id $3=type $4=title $5=summary $6=body $7=fields(jsonb)
// $8=author_identity $9=content_hash $10=origin_branch $11=origin_pr $12=embedding(vector|null)
// $13=revalidation_days (C4): revalidate_at = now() + N days, NULL for outcome (never expires).
// $14=provenance $15=approved_by (C5): from ApplyContext; a dedup (ON CONFLICT) leaves both untouched.
const INSERT_MEMORY_SQL = `
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
`.trim();

// Dedup re-select: find existing memory by (project_id, content_hash).
// $1=project_id  $2=content_hash
const SELECT_MEMORY_BY_HASH_SQL = `
SELECT id FROM memory WHERE project_id = $1 AND content_hash = $2
`.trim();

// A2: Insert memory_revision for add op (new rows only; revision_no always 1).
// content_tsv N/A on memory_revision.
// $1=memory_id $2=title $3=summary $4=body $5=fields(jsonb) $6=type
// $7=content_hash $8=author_identity $9=promoted_from_item
const INSERT_REVISION_ADD_SQL = `
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, 1, 'add', $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
`.trim();

// M1/S1: Lock memory row for amend/supersede (L3: AND project_id re-asserts
// tenant so a cross-project target_memory_id is treated as stale/not-found).
// type feeds the SEC M-1 apply-time guard (requiresReview).
// $1=memory_id  $2=project_id
const LOCK_MEMORY_SQL = `
SELECT id, current_revision, status, type FROM memory WHERE id = $1 AND project_id = $2 FOR UPDATE
`.trim();

// M2: Update memory content for amend op.
// content_tsv OMITTED — regenerates automatically.
// May throw 23505 if content_hash already exists on a different row.
// $1=title $2=summary $3=body $4=fields(jsonb) $5=type $6=content_hash
// $7=author_identity $8=origin_branch $9=origin_pr $10=memory_id $11=project_id
// $12=embedding(vector|null) $13=revalidation_days (C4) $14=provenance $15=approved_by (C5)
// L3: AND project_id = $11 ensures cross-project targets are treated as stale.
// Amend may change the type ($5), so the deadline CASE uses the NEW type.
// approved_by = $15 (no COALESCE): an automatic amend clears the previous approver,
// who never saw the new content.
const UPDATE_MEMORY_AMEND_SQL = `
UPDATE memory
SET title = $1, summary = $2, body = $3, fields = $4::jsonb, type = $5,
    content_hash = $6, author_identity = $7, provenance = $14::provenance,
    approved_by = $15::uuid,
    origin_branch = $8, origin_pr = $9, embedding = $12::vector,
    revalidate_at = CASE WHEN $5::memory_type = 'outcome' THEN NULL
                         ELSE now() + make_interval(days => $13::int) END,
    current_revision = current_revision + 1, updated_at = now()
WHERE id = $10 AND project_id = $11
`.trim();

// M3: Insert revision for amend op.
// $1=memory_id $2=revision_no $3=title $4=summary $5=body $6=fields(jsonb) $7=type
// $8=content_hash $9=author_identity $10=promoted_from_item
const INSERT_REVISION_AMEND_SQL = `
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, $2, 'amend', $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
`.trim();

// S3: Insert revision for supersede op (new memory rows only; revision_no always 1).
// $1=memory_id $2=title $3=summary $4=body $5=fields(jsonb) $6=type
// $7=content_hash $8=author_identity $9=promoted_from_item
const INSERT_REVISION_SUPERSEDE_SQL = `
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, 1, 'supersede', $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
`.trim();

// S4: Mark old memory as superseded.
// L3: AND project_id = $2 prevents marking a cross-project row superseded.
// $1=memory_id  $2=project_id
const UPDATE_MEMORY_SUPERSEDED_SQL = `
UPDATE memory SET status = 'superseded', updated_at = now() WHERE id = $1 AND project_id = $2
`.trim();

// S5: Insert typed edge new──supersedes──▶old. ON CONFLICT DO NOTHING → idempotent re-run.
// $1=from_memory (new)  $2=to_memory (old)
const INSERT_MEMORY_RELATION_SQL = `
INSERT INTO memory_relation (from_memory, to_memory, relation_type, source)
VALUES ($1, $2, 'supersedes', 'judge')
ON CONFLICT (from_memory, to_memory, relation_type) DO NOTHING
`.trim();

// D1: Lock target memory for deprecate — also snapshots content for the revision.
// L3: AND project_id = $2 re-asserts tenant (cross-project target → treated as stale).
// $1=memory_id  $2=project_id
const LOCK_MEMORY_FOR_DEPRECATE_SQL = `
SELECT id, current_revision, status, title, summary, body, fields, type, content_hash
FROM memory WHERE id = $1 AND project_id = $2 FOR UPDATE
`.trim();

// D2: Flip status to deprecated, bump current_revision.
// L3: AND project_id = $2 prevents mutating a cross-project row.
// $1=memory_id  $2=project_id
const UPDATE_MEMORY_DEPRECATED_SQL = `
UPDATE memory SET status = 'deprecated', current_revision = current_revision + 1,
                  updated_at = now()
WHERE id = $1 AND project_id = $2
`.trim();

// D3: Insert revision for deprecate op — uses the target's snapshotted content.
// $1=memory_id $2=revision_no $3=title $4=summary $5=body $6=fields(jsonb) $7=type
// $8=content_hash $9=author_identity $10=promoted_from_item
const INSERT_REVISION_DEPRECATE_SQL = `
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, $2, 'deprecate', $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
`.trim();

// Common final: first-writer-wins per-item commit guard (Decision 1).
// $1=promoted_memory_id  $2=item_id
const MARK_APPLIED_SQL = `
UPDATE staging_item
SET promoted_at = now(), promoted_memory_id = $1, judge_state = 'accepted'
WHERE id = $2 AND promoted_at IS NULL
`.trim();

// Q1: Quarantine snapshot (self-contained; NO FK to staging → sweep-safe).
// $1=project_id $2=repo_id $3=origin_session_id $4=origin_item_id $5=op $6=type
// $7=title $8=summary $9=body $10=fields(jsonb) $11=content_hash $12=judge_reason
// $13=author_identity $14=criterion $15=reason_code $16=related_memory_id
// $17=target_memory_id $18=target_revision $19=retention_days
const INSERT_QUARANTINE_SQL = `
INSERT INTO quarantine
  (project_id, repo_id, origin_session_id, origin_item_id, op, type,
   title, summary, body, fields, content_hash, judge_reason, author_identity,
   criterion, reason_code, related_memory_id, target_memory_id, target_revision, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
        $14::quarantine_criterion, $15::quarantine_reason_code, $16, $17, $18,
        now() + make_interval(days => $19::int))
RETURNING id
`.trim();

// Q2: Mark the staging item terminal and overwrite its content with the
// (masked / redacted) snapshot so a redacted secret never lingers in staging.
// content_hash: kept for redact 'none' ($12 NULL); for 'spans'/'whole' it is
// replaced (SEC-M2) so the hash of the secret-bearing content is not kept either.
// Guarded (SEC M-3): an item applied or human-reviewed meanwhile is not touched
// (0 rows → Q1 rolled back).
// $1=judge_reason $2=judge_criterion $3=judge_confidence $4=related_memory_id
// $5=mandatory_review $6=sanitize_flags(jsonb) $7=title $8=summary $9=body
// $10=fields(jsonb) $11=item_id $12=content_hash|null
const MARK_QUARANTINED_SQL = `
UPDATE staging_item
SET judge_state = 'rejected', judge_reason = $1, judge_criterion = $2,
    judge_confidence = $3, related_memory_id = $4, mandatory_review = $5,
    sanitize_flags = $6::jsonb, title = $7, summary = $8, body = $9, fields = $10::jsonb,
    content_hash = COALESCE($12, content_hash)
WHERE id = $11 AND promoted_at IS NULL AND reviewed_at IS NULL
`.trim();

// ---------------------------------------------------------------------------
// Human review (C2). Lock order: item → target memory → related memory, the
// same order as applyAccepted (item → memory).
// ---------------------------------------------------------------------------

// R0: lock a queued item of the project + its session metadata. Under READ
// COMMITTED a concurrent committed approve/reject makes the re-evaluated
// predicate fail → 0 rows (first writer wins). $1=item_id $2=project_id
const LOCK_QUEUED_ITEM_SQL = `
SELECT si.id, si.op, si.type, si.title, si.summary, si.body, si.fields, si.content_hash,
       si.target_memory_id, si.target_revision,
       si.judge_state, si.judge_reason,
       si.judge_criterion, si.judge_confidence, si.related_memory_id,
       si.mandatory_review, si.sanitize_flags,
       si.author_identity, si.promoted_at, si.promoted_memory_id,
       ss.id AS session_id, ss.repo_id, ss.branch, ss.pr_number
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
WHERE si.id = $1 AND ss.project_id = $2 AND ${QUEUED_PREDICATE}
FOR UPDATE OF si
`.trim();

// R3: rebase a stale item onto the revision the reviewer confirmed.
// $1=target_revision $2=item_id
const REBASE_ITEM_SQL = `
UPDATE staging_item SET target_revision = $1 WHERE id = $2
`.trim();

// R6: mark applied + approved. judge_state is NOT touched (keeps the judge label).
// $1=promoted_memory_id $2=reviewed_by $3=item_id
const MARK_APPROVED_SQL = `
UPDATE staging_item
SET promoted_at = now(), promoted_memory_id = $1,
    reviewed_by = $2, review_decision = 'approved', reviewed_at = now()
WHERE id = $3 AND promoted_at IS NULL AND reviewed_at IS NULL
`.trim();

// R8: supersede the related active memory. $1=memory_id $2=project_id
const SUPERSEDE_RELATED_SQL = `
UPDATE memory SET status = 'superseded', updated_at = now()
WHERE id = $1 AND project_id = $2 AND status = 'active'
`.trim();

// R8: human-sourced supersedes edge. $1=from_memory (new) $2=to_memory (related)
const INSERT_HUMAN_RELATION_SQL = `
INSERT INTO memory_relation (from_memory, to_memory, relation_type, source)
VALUES ($1, $2, 'supersedes', 'human')
ON CONFLICT (from_memory, to_memory, relation_type) DO NOTHING
`.trim();

// Reject: review columns; judge_state is NOT touched.
// $1=reviewed_by $2=review_reason $3=item_id
const MARK_REJECTED_SQL = `
UPDATE staging_item
SET reviewed_by = $1, review_decision = 'rejected', review_reason = $2, reviewed_at = now()
WHERE id = $3 AND promoted_at IS NULL AND reviewed_at IS NULL
`.trim();

// Abandon (HU-04.2). $1=session_id $2=project_id
const ABANDON_SESSION_SQL = `
UPDATE staging_session SET status = 'abandoned', last_activity_at = now()
WHERE id = $1 AND project_id = $2 AND status = 'open'
`.trim();

// Promoted rows are kept: memory_revision.promoted_from_item points at them.
// $1=session_id
const DELETE_UNPROMOTED_ITEMS_SQL = `
DELETE FROM staging_item WHERE session_id = $1 AND promoted_at IS NULL
`.trim();

// Finalize session: set terminal status.
// $1=status ('promoted'|'rejected'|'partially_promoted')  $2=session_id
const FINALIZE_SESSION_SQL = `
UPDATE staging_session
SET status = $1::staging_status, promoted_at = now()
WHERE id = $2 AND status = 'open'
`.trim();

// ---------------------------------------------------------------------------
// Raw row types (pg-typed; private to this module)
// ---------------------------------------------------------------------------

interface RawPromotionItemRow {
  id: string;
  op: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  content_hash: string;
  target_memory_id: string | null;
  target_revision: number | null;
  target_type: string | null;
  judge_state: string;
  judge_reason: string | null;
  judge_criterion: string | null;
  judge_confidence: number | null;
  related_memory_id: string | null;
  mandatory_review: boolean;
  sanitize_flags: SanitizeFlags;
  author_identity: string;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

interface RawMemoryLockRow {
  id: string;
  current_revision: number;
  status: string;
  type: string;
}

interface RawMemoryDeprecateLockRow extends RawMemoryLockRow {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  content_hash: string;
}

/**
 * SEC M-1 apply-time guard: an op may never change the type of its target, and a
 * mandatory-review target type is never mutated without a human.
 */
function requiresReview(
  item: PromotionItemRow,
  targetType: string,
  mandatoryTypes: ReadonlySet<MemoryType>,
): boolean {
  return targetType !== item.type || mandatoryTypes.has(targetType as MemoryType);
}

/**
 * SEC-M2: staging content_hash for a redacted quarantine ('spans'/'whole'): the
 * hash of the redacted content mixed with the item id. The id keeps it unique,
 * so two items redacted to the same text (e.g. two whole sentinels) never hit
 * UNIQUE(session_id, content_hash). null = keep the current hash ('none').
 */
export function stagingRedactedHash(
  itemId: string,
  redact: QuarantineRedaction,
  redactedContentHash: string,
): string | null {
  return redact === 'none' ? null : sha256Hex(`${itemId}:${redactedContentHash}`);
}

/** Raw R0 lock row: item columns (no target_type) + session metadata. */
interface RawQueuedItemRow extends Omit<RawPromotionItemRow, 'target_type'> {
  session_id: string;
  repo_id: string;
  branch: string;
  pr_number: number | null;
}

function toItemRow(r: RawPromotionItemRow): PromotionItemRow {
  return {
    id: r.id,
    op: r.op as PromotionItemRow['op'],
    type: r.type as MemoryType,
    title: r.title,
    summary: r.summary,
    body: r.body,
    fields: r.fields,
    content_hash: r.content_hash,
    target_memory_id: r.target_memory_id,
    target_revision: r.target_revision,
    target_type: r.target_type as MemoryType | null,
    judge_state: r.judge_state as PromotionItemRow['judge_state'],
    judge_reason: r.judge_reason,
    judge_criterion: r.judge_criterion as PromotionItemRow['judge_criterion'],
    judge_confidence: r.judge_confidence,
    related_memory_id: r.related_memory_id,
    mandatory_review: r.mandatory_review,
    sanitize_flags: r.sanitize_flags ?? {},
    author_identity: r.author_identity,
    promoted_at: r.promoted_at,
    promoted_memory_id: r.promoted_memory_id,
  };
}

/**
 * Human approval (review approve, C5 direct write): a mandatory-review target
 * type does not block the human. The type-change half of SEC M-1 still applies.
 */
export const NO_MANDATORY_TYPES: ReadonlySet<MemoryType> = new Set();

// ---------------------------------------------------------------------------
// Judge-context query builder
// ---------------------------------------------------------------------------

/**
 * Builds the websearch_to_tsquery string: lowercase runs of 3+ Unicode letters
 * or digits (so accented words stay whole), deduped, first 16, joined with
 * ' or '. Returns [] when no tokens remain. Always sent as a bind parameter.
 */
export function toOrQuery(title: string, summary: string): string[] {
  const tokens = `${title} ${summary}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 16);
  return unique.length === 0 ? [] : [unique.join(' or ')];
}

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export interface PromotionRepositoryOptions {
  /** QUARANTINE_RETENTION_DAYS: expires_at = now() + this many days on every insert. */
  quarantineRetentionDays: number;
  /** REVALIDATION_DAYS (C4): revalidate_at = now() + this many days on every apply (outcome → NULL). */
  revalidationDays: number;
}

export class PgPromotionRepository implements PromotionRepository {
  // The options are required on purpose: a default would let retention drift from config.
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: PromotionRepositoryOptions,
  ) {
    // Defence in depth for tests and scripts that bypass loadConfig.
    if (!Number.isInteger(opts.revalidationDays) || opts.revalidationDays < 1) {
      throw new Error('PgPromotionRepository: revalidationDays must be an integer >= 1');
    }
  }

  /**
   * Issues a ROLLBACK and swallows any error (e.g. already-aborted connection).
   * Used before early returns from applyAccepted and quarantineItem.
   */
  private async safeRollback(client: pg.PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore — connection may already be in an error state.
    }
  }

  async findOpenSessionId(tenant: TenantContext): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(FIND_OPEN_SESSION_SQL, [
      tenant.projectId,
      tenant.repoId,
      tenant.branch,
    ]);
    return rows[0]?.id ?? null;
  }

  async fetchPromotableItems(sessionId: string, projectId: string): Promise<PromotionItemRow[]> {
    const { rows } = await this.pool.query<RawPromotionItemRow>(
      FETCH_PROMOTABLE_ITEMS_SQL,
      [sessionId, projectId],
    );
    return rows.map(toItemRow);
  }

  async findJudgeContext(
    projectId: string,
    text: { title: string; summary: string },
    excludeMemoryId: string | null,
  ): Promise<JudgeContextItem[]> {
    const [query] = toOrQuery(text.title, text.summary);
    if (query === undefined) return [];
    const { rows } = await this.pool.query<{ id: string; type: string; title: string; summary: string }>(
      FIND_JUDGE_CONTEXT_SQL,
      [query, projectId, excludeMemoryId],
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      summary: r.summary,
    }));
  }

  async persistMasked(
    itemId: string,
    content: { title: string; summary: string; body: string; fields: Record<string, unknown> },
    contentHash: string,
    flags: SanitizeFlags,
  ): Promise<'ok' | 'hash_conflict'> {
    try {
      await this.pool.query(PERSIST_MASKED_SQL, [
        content.title, content.summary, content.body,
        JSON.stringify(content.fields),
        contentHash, JSON.stringify(flags), itemId,
      ]);
      return 'ok';
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'hash_conflict';
      throw err;
    }
  }

  async recordDecision(itemId: string, d: PersistedDecision, flags: SanitizeFlags): Promise<void> {
    await this.pool.query(RECORD_DECISION_SQL, [
      d.verdict, d.reason, d.criterion, d.confidence,
      d.relatedMemoryId, d.mandatoryReview, JSON.stringify(flags), itemId,
    ]);
  }

  /**
   * Applies one accepted item inside a per-item BEGIN…COMMIT/ROLLBACK transaction.
   * FOR UPDATE lock on the staging_item row + promoted_at IS NULL guard enforce
   * first-writer-wins semantics across concurrent promote() calls. A row already
   * resolved by a human (reviewed_at set) is never applied → 'already'.
   * embedding is the pre-computed vector (null when embed failed or op=deprecate).
   * A target whose type differs from the item's, or is in mandatoryTypes, is not
   * touched → { status: 'review_required' } (SEC M-1 defence in depth).
   */
  async applyAccepted(
    item: PromotionItemRow,
    ctx: ApplyContext,
    embedding: number[] | null,
    mandatoryTypes: ReadonlySet<MemoryType>,
  ): Promise<ApplyResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // S0: Lock the item row + idempotency / human-decision guard.
      const lockRes = await client.query<{ promoted_at: Date | null; reviewed_at: Date | null }>(
        LOCK_ITEM_SQL,
        [item.id],
      );
      const locked = lockRes.rows[0];
      if ((locked?.promoted_at ?? null) !== null || (locked?.reviewed_at ?? null) !== null) {
        // Already applied by a prior run or resolved by a human — commit the no-op.
        await client.query('COMMIT');
        return { status: 'already' };
      }

      const r = await this.applyOpInTxn(client, item, ctx, embedding, mandatoryTypes);
      if (r.status !== 'applied') {
        await this.safeRollback(client);
        return r;
      }

      // Common final: first-writer-wins UPDATE — 0 rows means raced by another process.
      const finalRes = await client.query(MARK_APPLIED_SQL, [r.memoryId, item.id]);
      if ((finalRes.rowCount ?? 0) === 0) {
        await this.safeRollback(client);
        return { status: 'already' };
      }

      await client.query('COMMIT');
      return r;
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transaction-scoped apply core shared by promotion (applyAccepted) and human
   * review (approveReviewItem): the op branches A1/A2, M1–M3, S1–S5, D1–D3.
   * Never issues BEGIN, COMMIT or ROLLBACK — the caller rolls back on any
   * non-applied result (after a 23505 the transaction is already aborted).
   */
  private async applyOpInTxn(
    client: pg.PoolClient,
    item: PromotionItemRow,
    ctx: ApplyContext,
    embedding: number[] | null,
    mandatoryTypes: ReadonlySet<MemoryType>,
  ): Promise<OpResult> {
    if (item.op === 'add') {
      // A1: Insert authoritative memory.
      const memRes = await client.query<{ id: string }>(INSERT_MEMORY_SQL, [
        ctx.projectId, ctx.repoId, item.type,
        item.title, item.summary, item.body,
        JSON.stringify(item.fields),
        item.author_identity, item.content_hash,
        ctx.originBranch, ctx.originPr,
        toVectorParam(embedding),   // $12
        this.opts.revalidationDays, // $13
        ctx.provenance,             // $14
        ctx.approvedBy,             // $15
      ]);

      if (memRes.rows.length === 0) {
        // ON CONFLICT hit — content already in memory; find existing row.
        const dupRes = await client.query<{ id: string }>(SELECT_MEMORY_BY_HASH_SQL, [
          ctx.projectId, item.content_hash,
        ]);
        // A2 SKIPPED — existing memory already carries revision 1.
        return { status: 'applied', memoryId: dupRes.rows[0]!.id, deduped: true };
      }
      const memoryId = memRes.rows[0]!.id;
      // A2: Insert revision only for newly-inserted rows.
      await client.query(INSERT_REVISION_ADD_SQL, [
        memoryId,
        item.title, item.summary, item.body,
        JSON.stringify(item.fields),
        item.type, item.content_hash,
        item.author_identity, item.id,
      ]);
      return { status: 'applied', memoryId, deduped: false };
    }

    if (item.op === 'amend') {
      // M1: Lock target memory row + stale check (L3: project_id re-asserts tenant).
      const targetRes = await client.query<RawMemoryLockRow>(LOCK_MEMORY_SQL, [
        item.target_memory_id,
        ctx.projectId,
      ]);
      if (
        targetRes.rows.length === 0 ||
        targetRes.rows[0]!.current_revision !== item.target_revision ||
        targetRes.rows[0]!.status !== 'active'
      ) {
        return { status: 'stale' };
      }
      if (requiresReview(item, targetRes.rows[0]!.type, mandatoryTypes)) {
        return { status: 'review_required' };
      }
      const prevRevision = targetRes.rows[0]!.current_revision;

      // M2: Update memory content — may throw 23505 on duplicate content_hash.
      try {
        await client.query(UPDATE_MEMORY_AMEND_SQL, [
          item.title, item.summary, item.body,
          JSON.stringify(item.fields),
          item.type, item.content_hash,
          item.author_identity,
          ctx.originBranch, ctx.originPr,
          item.target_memory_id,
          ctx.projectId,          // $11 — L3 tenant guard
          toVectorParam(embedding), // $12
          this.opts.revalidationDays, // $13
          ctx.provenance,             // $14
          ctx.approvedBy,             // $15
        ]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return { status: 'duplicate' };
        throw err;
      }

      // M3: Insert revision.
      await client.query(INSERT_REVISION_AMEND_SQL, [
        item.target_memory_id, prevRevision + 1,
        item.title, item.summary, item.body,
        JSON.stringify(item.fields),
        item.type, item.content_hash,
        item.author_identity, item.id,
      ]);

      return { status: 'applied', memoryId: item.target_memory_id!, deduped: false };
    }

    if (item.op === 'supersede') {
      // S1: Lock + stale check on the old target memory row (L3: project_id re-asserts tenant).
      const targetRes = await client.query<RawMemoryLockRow>(LOCK_MEMORY_SQL, [
        item.target_memory_id,
        ctx.projectId,
      ]);
      if (
        targetRes.rows.length === 0 ||
        targetRes.rows[0]!.current_revision !== item.target_revision ||
        targetRes.rows[0]!.status !== 'active'
      ) {
        return { status: 'stale' };
      }
      if (requiresReview(item, targetRes.rows[0]!.type, mandatoryTypes)) {
        return { status: 'review_required' };
      }

      // S2: Insert new memory (same column list as A1).
      const newMemRes = await client.query<{ id: string }>(INSERT_MEMORY_SQL, [
        ctx.projectId, ctx.repoId, item.type,
        item.title, item.summary, item.body,
        JSON.stringify(item.fields),
        item.author_identity, item.content_hash,
        ctx.originBranch, ctx.originPr,
        toVectorParam(embedding),   // $12
        this.opts.revalidationDays, // $13
        ctx.provenance,             // $14
        ctx.approvedBy,             // $15
      ]);

      let newMemoryId: string;
      let deduped: boolean;
      if (newMemRes.rows.length === 0) {
        // Dedup: new content already exists in memory.
        const dupRes = await client.query<{ id: string }>(SELECT_MEMORY_BY_HASH_SQL, [
          ctx.projectId, item.content_hash,
        ]);
        newMemoryId = dupRes.rows[0]!.id;
        deduped = true;
        // S3 SKIPPED — existing memory already has its revision.
      } else {
        newMemoryId = newMemRes.rows[0]!.id;
        deduped = false;
        // S3: Insert revision for the new memory row.
        await client.query(INSERT_REVISION_SUPERSEDE_SQL, [
          newMemoryId,
          item.title, item.summary, item.body,
          JSON.stringify(item.fields),
          item.type, item.content_hash,
          item.author_identity, item.id,
        ]);
      }

      // L1 self-supersede guard: if dedup resolved the new content to the same
      // memory row as the target, the item's content is identical to what it
      // intended to replace. Inserting a self-relation would violate
      // CHECK (from_memory <> to_memory) with code 23514 → short-circuit as duplicate.
      if (newMemoryId === item.target_memory_id) return { status: 'duplicate' };

      // S4: Mark old memory as superseded (L3: project_id re-asserts tenant).
      await client.query(UPDATE_MEMORY_SUPERSEDED_SQL, [item.target_memory_id, ctx.projectId]);

      // S5: Insert typed edge — ON CONFLICT DO NOTHING makes re-runs idempotent.
      await client.query(INSERT_MEMORY_RELATION_SQL, [newMemoryId, item.target_memory_id]);

      return { status: 'applied', memoryId: newMemoryId, deduped };
    }

    // op === 'deprecate'
    // D1: Lock target memory row + stale check; also snapshot current content.
    // L3: project_id passed to re-assert tenant ownership.
    const targetRes = await client.query<RawMemoryDeprecateLockRow>(
      LOCK_MEMORY_FOR_DEPRECATE_SQL,
      [item.target_memory_id, ctx.projectId],
    );
    if (
      targetRes.rows.length === 0 ||
      targetRes.rows[0]!.current_revision !== item.target_revision ||
      targetRes.rows[0]!.status !== 'active'
    ) {
      return { status: 'stale' };
    }
    const snap = targetRes.rows[0]!;
    if (requiresReview(item, snap.type, mandatoryTypes)) {
      return { status: 'review_required' };
    }

    // D2: Flip status to deprecated + bump current_revision (L3: project_id guard).
    await client.query(UPDATE_MEMORY_DEPRECATED_SQL, [item.target_memory_id, ctx.projectId]);

    // D3: Insert revision using the snapshotted target content.
    await client.query(INSERT_REVISION_DEPRECATE_SQL, [
      item.target_memory_id, snap.current_revision + 1,
      snap.title, snap.summary, snap.body,
      JSON.stringify(snap.fields),
      snap.type, snap.content_hash,
      item.author_identity, item.id,
    ]);

    return { status: 'applied', memoryId: item.target_memory_id!, deduped: false };
  }

  /**
   * Snapshots the item in quarantine and marks it terminal in staging.
   * The stored content (none / spans re-checked / whole sentinel) is written to
   * BOTH tables; reason is category-only (no matched text). An item applied or
   * human-reviewed meanwhile is left alone (no orphan snapshot) → null.
   */
  async quarantineItem(
    item: PromotionItemRow,
    ctx: ApplyContext,
    q: QuarantineInput,
  ): Promise<string | null> {
    const d = q.decision;
    // Reviewer M1: a non-redacted judge rejection (duplication / specificity)
    // keeps the judge justification on the staging row; quarantine keeps the code.
    const stagingReason = q.redact === 'none' && d?.verdict === 'rejected' ? d.reason : q.reason;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Q1: Self-contained snapshot (no FK to staging -> sweep-safe).
      const snap = await this.insertQuarantineSnapshot(client, item, ctx, q);

      // Q2: Mark staging item terminal (promoted_at stays NULL).
      const marked = await client.query(MARK_QUARANTINED_SQL, [
        stagingReason, d?.criterion ?? null, d?.confidence ?? null,
        d?.relatedMemoryId ?? null, d?.mandatoryReview ?? false,
        JSON.stringify(q.sanitizeFlags),
        snap.title, snap.summary, snap.body, snap.fieldsJson,
        item.id, stagingRedactedHash(item.id, q.redact, snap.contentHash),
      ]);
      if ((marked.rowCount ?? 0) === 0) {
        // SEC M-3: applied or human-reviewed meanwhile — drop the Q1 snapshot too.
        await this.safeRollback(client);
        logger.warn('[promote] quarantine skipped: item resolved concurrently', { itemId: item.id });
        return null;
      }

      await client.query('COMMIT');
      return snap.id;
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Transaction-scoped quarantine core (Q1) shared by promotion (quarantineItem)
   * and human review (rejectReviewItem) — the single quarantine write choke
   * point. Computes the stored content from the redaction mode, classifies the
   * reason, records related/target and the expiry, and returns the new id plus
   * the stored content so the caller can mirror it on the staging row.
   */
  private async insertQuarantineSnapshot(
    client: pg.PoolClient,
    item: PromotionItemRow,
    ctx: ApplyContext,
    q: QuarantineInput,
  ): Promise<{
    id: string;
    title: string;
    summary: string;
    body: string;
    fieldsJson: string;
    contentHash: string;
  }> {
    const given = { title: item.title, summary: item.summary, body: item.body, fields: item.fields };
    let stored = given;
    if (q.redact === 'whole') {
      stored = { ...WHOLE_REDACTION, fields: {} };
    } else if (q.redact === 'spans' && !isSecretFree(given)) {
      // Defence in depth: sanitize already span-redacted; anything left → whole.
      logger.warn('[promote] span redaction re-check failed — whole-field fallback', {
        itemId: item.id,
      });
      stored = { ...WHOLE_REDACTION, fields: {} };
    }
    const fieldsJson = JSON.stringify(stored.fields);
    // SEC L-7: a redacted snapshot never carries the hash of the secret-bearing content.
    const quarantineHash =
      q.redact === 'none'
        ? item.content_hash
        : computeContentHash({
            op: item.op, type: item.type,
            title: stored.title, summary: stored.summary, body: stored.body, fields: stored.fields,
            target: item.target_memory_id,
          });

    const { criterion, reasonCode } = classifyQuarantine(q.reason, q.decision?.criterion ?? null);
    // A routed decision is authoritative (only R3 carries one); a human reject
    // keeps the related memory the reviewer saw.
    const relatedMemoryId = q.decision ? q.decision.relatedMemoryId : item.related_memory_id;

    const { rows } = await client.query<{ id: string }>(INSERT_QUARANTINE_SQL, [
      ctx.projectId, ctx.repoId,
      ctx.sessionId, item.id,
      item.op, item.type,
      stored.title, stored.summary, stored.body,
      fieldsJson,
      quarantineHash, q.reason, item.author_identity,
      criterion, reasonCode, relatedMemoryId,
      item.target_memory_id, item.target_revision,
      this.opts.quarantineRetentionDays,
    ]);
    return {
      id: rows[0]!.id,
      title: stored.title,
      summary: stored.summary,
      body: stored.body,
      fieldsJson,
      contentHash: quarantineHash,
    };
  }

  /**
   * R0: locks a queued item of the project; null when it is not (or no longer) queued.
   * approvedBy: the reviewer on approve (written as memory.approved_by); null on reject.
   */
  private async lockQueuedItem(
    client: pg.PoolClient,
    itemId: string,
    projectId: string,
    approvedBy: string | null,
  ): Promise<{ item: PromotionItemRow; ctx: ApplyContext } | null> {
    const { rows } = await client.query<RawQueuedItemRow>(LOCK_QUEUED_ITEM_SQL, [itemId, projectId]);
    const r = rows[0];
    if (!r) return null;
    // target_type is filled from the locked target row (R1) when needed.
    const item = toItemRow({ ...r, target_type: null });
    const ctx: ApplyContext = {
      projectId,
      repoId: r.repo_id,
      originBranch: r.branch,
      originPr: r.pr_number,
      sessionId: r.session_id,
      // C2: human approval goes in approved_by, not in provenance.
      provenance: 'pr_reviewed',
      approvedBy,
    };
    return { item, ctx };
  }

  /**
   * Human approval (HU-07.2). One transaction; every early exit rolls back and
   * leaves the item queued. Steps R0–R8 (see design):
   *  R0 lock + queue guard → R1 lock target (op ≠ add) → R2 revision check →
   *  R3 rebase a stale target the reviewer confirmed → R4 embedding guard →
   *  R5 shared apply core (writes approved_by = reviewer via ctx; a dedup leaves
   *  the existing approver) → R6 mark approved → R8 related.
   *
   * SEC M-1 on the human path: the reviewer IS the human gate, so a
   * mandatory-review target type does not block approval (the core gets an
   * empty mandatory set). A target whose type differs from the item's would
   * still change the target's type, so it is refused as `target_inactive`
   * (the item can only be rejected; reloading would not help, unlike
   * `target_changed`).
   */
  async approveReviewItem(i: ReviewApproveInput): Promise<ReviewApproveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // R0
      const locked = await this.lockQueuedItem(client, i.itemId, i.projectId, i.reviewerUserId);
      if (!locked) {
        await this.safeRollback(client);
        return { status: 'not_found' };
      }
      const { item, ctx } = locked;

      let rebasedFromRevision: number | null = null;
      let rebasedToRevision: number | null = null;
      if (item.op !== 'add') {
        // R1
        const target = item.target_memory_id
          ? (await client.query<RawMemoryLockRow>(LOCK_MEMORY_SQL, [item.target_memory_id, i.projectId]))
              .rows[0]
          : undefined;
        if (!target || target.status !== 'active' || target.type !== item.type) {
          await this.safeRollback(client);
          return { status: 'conflict', code: 'target_inactive' };
        }
        item.target_type = target.type as MemoryType;

        // R2: the reviewer must confirm the version they saw.
        const cur = target.current_revision;
        const stale = cur !== item.target_revision;
        if ((i.targetRevision !== null && i.targetRevision !== cur) || (stale && i.targetRevision !== cur)) {
          await this.safeRollback(client);
          return { status: 'conflict', code: 'target_changed' };
        }

        // R3
        if (stale) {
          await client.query(REBASE_ITEM_SQL, [cur, item.id]);
          rebasedFromRevision = item.target_revision;
          rebasedToRevision = cur;
          item.target_revision = cur;
        }
      }

      // R4: a concurrent persistMasked changed the content → fail-soft null.
      let embedding = i.embedding;
      if (embedding !== null && item.content_hash !== i.expectedContentHash) {
        logger.warn('[review] embedding dropped: item content changed', { itemId: item.id });
        embedding = null;
      }

      // R5: same apply SQL as promotion; no mandatory-type block (human gate).
      const r = await this.applyOpInTxn(client, item, ctx, embedding, NO_MANDATORY_TYPES);
      if (r.status !== 'applied') {
        await this.safeRollback(client);
        const code: ConflictCode =
          r.status === 'duplicate'
            ? 'duplicate_content'
            : r.status === 'stale'
              ? 'target_changed' // unreachable after R1–R3; defensive
              : 'target_inactive'; // review_required: type mismatch, refused by R1 already
        return { status: 'conflict', code };
      }

      // R6
      const marked = await client.query(MARK_APPROVED_SQL, [r.memoryId, i.reviewerUserId, item.id]);
      if ((marked.rowCount ?? 0) === 0) {
        await this.safeRollback(client);
        return { status: 'not_found' };
      }

      // R8
      let relatedSuperseded = false;
      const related = item.related_memory_id;
      if (i.markRelatedSuperseded && related && item.op !== 'deprecate' && related !== r.memoryId) {
        const sup = await client.query(SUPERSEDE_RELATED_SQL, [related, i.projectId]);
        if ((sup.rowCount ?? 0) === 1) {
          await client.query(INSERT_HUMAN_RELATION_SQL, [r.memoryId, related]);
          relatedSuperseded = true;
        }
      }

      await client.query('COMMIT');
      return {
        status: 'approved',
        memoryId: r.memoryId,
        deduped: r.deduped,
        rebasedFromRevision,
        rebasedToRevision,
        relatedSuperseded,
      };
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Human rejection (HU-07.3): quarantine snapshot with judge_reason
   * 'human_review: <reason>' + review columns, in one transaction. Queued items
   * never carry secrets (sanitize quarantines those first), so no redaction.
   */
  async rejectReviewItem(i: ReviewRejectInput): Promise<'rejected' | 'not_found'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const locked = await this.lockQueuedItem(client, i.itemId, i.projectId, null);
      if (!locked) {
        await this.safeRollback(client);
        return 'not_found';
      }
      const { item, ctx } = locked;

      await this.insertQuarantineSnapshot(client, item, ctx, {
        reason: `${HUMAN_REVIEW_PREFIX}${i.reason}`,
        redact: 'none',
        decision: null,
        sanitizeFlags: item.sanitize_flags,
      });

      const marked = await client.query(MARK_REJECTED_SQL, [i.reviewerUserId, i.reason, item.id]);
      if ((marked.rowCount ?? 0) === 0) {
        await this.safeRollback(client);
        return 'not_found';
      }

      await client.query('COMMIT');
      return 'rejected';
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async abandonOpenSession(
    sessionId: string,
    projectId: string,
  ): Promise<{ abandoned: boolean; discarded: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(ABANDON_SESSION_SQL, [sessionId, projectId]);
      if ((upd.rowCount ?? 0) === 0) {
        // Not open (already abandoned / finalized) or not this project's session.
        await this.safeRollback(client);
        return { abandoned: false, discarded: 0 };
      }
      const del = await client.query(DELETE_UNPROMOTED_ITEMS_SQL, [sessionId]);
      await client.query('COMMIT');
      return { abandoned: true, discarded: del.rowCount ?? 0 };
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  async finalizeSession(
    sessionId: string,
    status: 'promoted' | 'rejected' | 'partially_promoted',
  ): Promise<void> {
    await this.pool.query(FINALIZE_SESSION_SQL, [status, sessionId]);
  }
}
