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
import { toVectorParam } from './vector.js';

// ---------------------------------------------------------------------------
// Types (exported for use by PromoteService and fakes)
// ---------------------------------------------------------------------------

export type Verdict = 'accepted' | 'rejected' | 'uncertain';

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
  judge_state: 'pending' | 'accepted' | 'uncertain' | 'rejected';
  judge_reason: string | null;
  author_identity: string;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

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
}

export type ApplyResult =
  | { status: 'applied'; memoryId: string; deduped: boolean }
  | { status: 'stale' }
  | { status: 'duplicate' }
  | { status: 'already' }; // promoted_at already set — idempotent no-op

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

  /** Persists the judge verdict and optional reason on the item row. */
  recordVerdict(itemId: string, verdict: Verdict, reason: string | null): Promise<void>;

  /**
   * Applies one accepted item inside a per-item transaction.
   * FOR UPDATE lock + promoted_at IS NULL guard enforces first-writer-wins.
   * embedding is the pre-computed vector (null when the embed failed or op=deprecate).
   */
  applyAccepted(item: PromotionItemRow, ctx: ApplyContext, embedding: number[] | null): Promise<ApplyResult>;

  /**
   * Snapshots the item in quarantine and marks it terminal (rejected).
   * When redact=true, title/summary/body are replaced with the redact sentinel.
   */
  quarantineItem(
    item: PromotionItemRow,
    ctx: ApplyContext,
    reason: string,
    redact: boolean,
  ): Promise<void>;

  /** Sets the session terminal status after all items have been processed. */
  finalizeSession(
    sessionId: string,
    status: 'promoted' | 'rejected' | 'partially_promoted',
  ): Promise<void>;
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
// different project's session cannot leak through even if session_id is known)
const FETCH_PROMOTABLE_ITEMS_SQL = `
SELECT si.id, si.op, si.type, si.title, si.summary, si.body, si.fields, si.content_hash,
       si.target_memory_id, si.target_revision, si.judge_state, si.judge_reason,
       si.author_identity, si.promoted_at, si.promoted_memory_id
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
WHERE si.session_id = $1 AND si.promoted_at IS NULL AND ss.project_id = $2
ORDER BY si.created_at ASC
`.trim();

// $1=judge_state  $2=judge_reason  $3=item_id
const RECORD_VERDICT_SQL = `
UPDATE staging_item SET judge_state = $1, judge_reason = $2 WHERE id = $3
`.trim();

// S0: Lock + idempotency guard. $1=item_id
const LOCK_ITEM_SQL = `
SELECT promoted_at FROM staging_item WHERE id = $1 FOR UPDATE
`.trim();

// A1/S2: Insert authoritative memory (add and supersede ops).
// content_tsv OMITTED — GENERATED ALWAYS.
// $1=project_id $2=repo_id $3=type $4=title $5=summary $6=body $7=fields(jsonb)
// $8=author_identity $9=content_hash $10=origin_branch $11=origin_pr $12=embedding(vector|null)
const INSERT_MEMORY_SQL = `
INSERT INTO memory
  (project_id, repo_id, type, title, summary, body, fields,
   status, provenance, author_identity, content_hash, current_revision,
   origin_branch, origin_pr, embedding)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
        'active', 'pr_reviewed', $8, $9, 1, $10, $11, $12::vector)
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
// $1=memory_id  $2=project_id
const LOCK_MEMORY_SQL = `
SELECT id, current_revision, status FROM memory WHERE id = $1 AND project_id = $2 FOR UPDATE
`.trim();

// M2: Update memory content for amend op.
// content_tsv OMITTED — regenerates automatically.
// May throw 23505 if content_hash already exists on a different row.
// $1=title $2=summary $3=body $4=fields(jsonb) $5=type $6=content_hash
// $7=author_identity $8=origin_branch $9=origin_pr $10=memory_id $11=project_id
// $12=embedding(vector|null)
// L3: AND project_id = $11 ensures cross-project targets are treated as stale.
const UPDATE_MEMORY_AMEND_SQL = `
UPDATE memory
SET title = $1, summary = $2, body = $3, fields = $4::jsonb, type = $5,
    content_hash = $6, author_identity = $7, provenance = 'pr_reviewed',
    origin_branch = $8, origin_pr = $9, embedding = $12::vector,
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
// $7=title $8=summary $9=body $10=fields(jsonb) $11=content_hash
// $12=judge_reason $13=author_identity
const INSERT_QUARANTINE_SQL = `
INSERT INTO quarantine
  (project_id, repo_id, origin_session_id, origin_item_id, op, type,
   title, summary, body, fields, content_hash, judge_reason, author_identity)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
`.trim();

// Q2: Mark the staging item terminal. $1=judge_reason  $2=item_id
const MARK_QUARANTINED_SQL = `
UPDATE staging_item SET judge_state = 'rejected', judge_reason = $1 WHERE id = $2
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
  judge_state: string;
  judge_reason: string | null;
  author_identity: string;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

interface RawMemoryLockRow {
  id: string;
  current_revision: number;
  status: string;
}

interface RawMemoryDeprecateLockRow extends RawMemoryLockRow {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  type: string;
  content_hash: string;
}

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgPromotionRepository implements PromotionRepository {
  constructor(private readonly pool: pg.Pool) {}

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
    return rows.map((r) => ({
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
      judge_state: r.judge_state as PromotionItemRow['judge_state'],
      judge_reason: r.judge_reason,
      author_identity: r.author_identity,
      promoted_at: r.promoted_at,
      promoted_memory_id: r.promoted_memory_id,
    }));
  }

  async recordVerdict(itemId: string, verdict: Verdict, reason: string | null): Promise<void> {
    await this.pool.query(RECORD_VERDICT_SQL, [verdict, reason, itemId]);
  }

  /**
   * Applies one accepted item inside a per-item BEGIN…COMMIT/ROLLBACK transaction.
   * FOR UPDATE lock on the staging_item row + promoted_at IS NULL guard enforce
   * first-writer-wins semantics across concurrent promote() calls.
   * embedding is the pre-computed vector (null when embed failed or op=deprecate).
   */
  async applyAccepted(item: PromotionItemRow, ctx: ApplyContext, embedding: number[] | null): Promise<ApplyResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // S0: Lock the item row + idempotency guard.
      const lockRes = await client.query<{ promoted_at: Date | null }>(LOCK_ITEM_SQL, [item.id]);
      if ((lockRes.rows[0]?.promoted_at ?? null) !== null) {
        // Already applied by a prior run — commit the no-op transaction.
        await client.query('COMMIT');
        return { status: 'already' };
      }

      let memoryId: string;
      let deduped = false;

      if (item.op === 'add') {
        // A1: Insert authoritative memory.
        const memRes = await client.query<{ id: string }>(INSERT_MEMORY_SQL, [
          ctx.projectId, ctx.repoId, item.type,
          item.title, item.summary, item.body,
          JSON.stringify(item.fields),
          item.author_identity, item.content_hash,
          ctx.originBranch, ctx.originPr,
          toVectorParam(embedding),   // $12
        ]);

        if (memRes.rows.length === 0) {
          // ON CONFLICT hit — content already in memory; find existing row.
          const dupRes = await client.query<{ id: string }>(SELECT_MEMORY_BY_HASH_SQL, [
            ctx.projectId, item.content_hash,
          ]);
          memoryId = dupRes.rows[0]!.id;
          deduped = true;
          // A2 SKIPPED — existing memory already carries revision 1.
        } else {
          memoryId = memRes.rows[0]!.id;
          deduped = false;
          // A2: Insert revision only for newly-inserted rows.
          await client.query(INSERT_REVISION_ADD_SQL, [
            memoryId,
            item.title, item.summary, item.body,
            JSON.stringify(item.fields),
            item.type, item.content_hash,
            item.author_identity, item.id,
          ]);
        }
      } else if (item.op === 'amend') {
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
          await this.safeRollback(client);
          return { status: 'stale' };
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
          ]);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            await this.safeRollback(client);
            return { status: 'duplicate' };
          }
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

        memoryId = item.target_memory_id!;
        deduped = false;
      } else if (item.op === 'supersede') {
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
          await this.safeRollback(client);
          return { status: 'stale' };
        }

        // S2: Insert new memory (same column list as A1).
        const newMemRes = await client.query<{ id: string }>(INSERT_MEMORY_SQL, [
          ctx.projectId, ctx.repoId, item.type,
          item.title, item.summary, item.body,
          JSON.stringify(item.fields),
          item.author_identity, item.content_hash,
          ctx.originBranch, ctx.originPr,
          toVectorParam(embedding),   // $12
        ]);

        let newMemoryId: string;
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
        if (newMemoryId === item.target_memory_id) {
          await this.safeRollback(client);
          return { status: 'duplicate' };
        }

        // S4: Mark old memory as superseded (L3: project_id re-asserts tenant).
        await client.query(UPDATE_MEMORY_SUPERSEDED_SQL, [item.target_memory_id, ctx.projectId]);

        // S5: Insert typed edge — ON CONFLICT DO NOTHING makes re-runs idempotent.
        await client.query(INSERT_MEMORY_RELATION_SQL, [newMemoryId, item.target_memory_id]);

        memoryId = newMemoryId;
      } else {
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
          await this.safeRollback(client);
          return { status: 'stale' };
        }
        const snap = targetRes.rows[0]!;

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

        memoryId = item.target_memory_id!;
        deduped = false;
      }

      // Common final: first-writer-wins UPDATE — 0 rows means raced by another process.
      const finalRes = await client.query(MARK_APPLIED_SQL, [memoryId, item.id]);
      if ((finalRes.rowCount ?? 0) === 0) {
        await this.safeRollback(client);
        return { status: 'already' };
      }

      await client.query('COMMIT');
      return { status: 'applied', memoryId, deduped };
    } catch (err) {
      await this.safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Snapshots the item in quarantine and marks it terminal in staging.
   * When redact=true (secret_detected path), title/summary/body are replaced
   * with the sentinel string; reason is category-only (no matched text).
   */
  async quarantineItem(
    item: PromotionItemRow,
    ctx: ApplyContext,
    reason: string,
    redact: boolean,
  ): Promise<void> {
    const REDACT_SENTINEL = '[REDACTED: secret detected]';
    const title = redact ? REDACT_SENTINEL : item.title;
    const summary = redact ? REDACT_SENTINEL : item.summary;
    const body = redact ? REDACT_SENTINEL : item.body;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Q1: Self-contained snapshot (no FK to staging → sweep-safe).
      await client.query(INSERT_QUARANTINE_SQL, [
        ctx.projectId, ctx.repoId,
        ctx.sessionId, item.id,
        item.op, item.type,
        title, summary, body,
        JSON.stringify(item.fields),
        item.content_hash, reason, item.author_identity,
      ]);

      // Q2: Mark staging item terminal (promoted_at stays NULL).
      await client.query(MARK_QUARANTINED_SQL, [reason, item.id]);

      await client.query('COMMIT');
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
