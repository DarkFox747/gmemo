/**
 * StagingRepository — the single DB seam for the staging write path.
 *
 * One open session per (project, repo, branch) — keyed by the partial
 * unique index `ux_session_open` on staging_session. Sessions are
 * lazy-created and carry a 7-day sliding TTL (Decision 3).
 *
 * All queries are parameterized and tenant-scoped: items are only reachable
 * through the caller's own open session (Decision 4). No string concatenation
 * of query text — $N parameters exclusively.
 *
 * Mirrors PgMemoryRepository structure: top-level SQL constants, private pool,
 * row-mapping helpers, null/empty on not-found, AppError on bad input.
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { TenantContext } from '../mcp/context.js';
import { AppError, ErrorCode } from '../errors/appError.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Supporting types (exported for use by handlers and fakes)
// ---------------------------------------------------------------------------

/** Internal projection of a staging_item row used by the write handlers. */
export interface StagingItemRow {
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
  created_at: Date;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

/** Parameters for inserting a new staging_item row. */
export interface InsertStagingItemParams {
  op: StagingItemRow['op'];
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  contentHash: string;
  targetMemoryId: string | null;
  targetRevision: number | null;
  /** Set by the handler per Decision 7 (stale handle → 'uncertain'). */
  judgeState: 'pending' | 'uncertain';
  authorIdentity: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StagingRepository {
  /**
   * Lazy upsert of the one open session for the tenant key; bumps 7-day
   * sliding TTL on every call. Returns the session id (ULID).
   */
  findOrCreateOpenSession(tenant: TenantContext, openedBy: string): Promise<string>;

  /**
   * Idempotent insert based on (session_id, content_hash) uniqueness.
   * Returns the (possibly pre-existing) item id, judge_state, and a
   * `deduped` flag that is true when the insert conflicted.
   */
  insertStagingItem(
    sessionId: string,
    p: InsertStagingItemParams,
  ): Promise<{ id: string; judgeState: StagingItemRow['judge_state']; deduped: boolean }>;

  /**
   * Returns the caller's own open-session items, newest first.
   * Returns an empty array when no open session exists.
   */
  listStagingItems(tenant: TenantContext): Promise<StagingItemRow[]>;

  /**
   * Deletes one item from the caller's open session.
   * Returns false when the item is not found (opaque — does not reveal
   * whether the item exists in another session).
   */
  discardStagingItem(tenant: TenantContext, itemId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Internal raw row types (pg-typed; private to this module)
// ---------------------------------------------------------------------------

interface RawSessionIdRow {
  id: string;
}

interface RawItemInsertRow {
  id: string;
  judge_state: string;
}

interface RawStagingItemRow {
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
  created_at: Date;
  promoted_at: Date | null;
  promoted_memory_id: string | null;
}

// ---------------------------------------------------------------------------
// SQL constants — parameterized, no string concatenation
// ---------------------------------------------------------------------------

// Decision 3: attempt insert; partial unique index ux_session_open guarantees
// at most one 'open' session per (project, repo, branch) at the DB level.
// $1=id(ULID)  $2=project_id  $3=repo_id  $4=branch  $5=opened_by
const FIND_OR_CREATE_SESSION_SQL = `
INSERT INTO staging_session
  (id, project_id, repo_id, branch, status, opened_by, last_activity_at, expires_at)
VALUES ($1, $2, $3, $4, 'open', $5, now(), now() + interval '7 days')
ON CONFLICT (project_id, repo_id, branch) WHERE status = 'open' DO NOTHING
RETURNING id
`.trim();

// Re-select path when INSERT returned nothing (conflict with existing session).
// $1=project_id  $2=repo_id  $3=branch
const SELECT_OPEN_SESSION_SQL = `
SELECT id FROM staging_session
WHERE project_id = $1 AND repo_id = $2 AND branch = $3 AND status = 'open'
`.trim();

// Sliding TTL bump — applied on both the insert and the re-select path.
// $1=session_id
const BUMP_SESSION_TTL_SQL = `
UPDATE staging_session
SET last_activity_at = now(), expires_at = now() + interval '7 days'
WHERE id = $1
`.trim();

// Idempotent insert; unique (session_id, content_hash) prevents duplicates.
// $1=session_id  $2=op  $3=type  $4=title  $5=summary  $6=body
// $7=fields(jsonb)  $8=content_hash  $9=target_memory_id  $10=target_revision
// $11=judge_state  $12=author_identity
const INSERT_STAGING_ITEM_SQL = `
INSERT INTO staging_item
  (session_id, op, type, title, summary, body, fields, content_hash,
   target_memory_id, target_revision, judge_state, author_identity)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
ON CONFLICT (session_id, content_hash) DO NOTHING
RETURNING id, judge_state
`.trim();

// Re-select on dedup conflict to return the pre-existing item.
// $1=session_id  $2=content_hash
const SELECT_STAGING_ITEM_BY_HASH_SQL = `
SELECT id, judge_state FROM staging_item
WHERE session_id = $1 AND content_hash = $2
`.trim();

// All items in the caller's own open session, newest first.
// Joins staging_session to enforce tenant scope — item only reachable via
// its session's (project_id, repo_id, branch, status='open').
// $1=project_id  $2=repo_id  $3=branch
const LIST_STAGING_ITEMS_SQL = `
SELECT i.id, i.op, i.type, i.title, i.summary, i.body, i.fields,
       i.content_hash, i.target_memory_id, i.target_revision,
       i.judge_state, i.created_at,
       i.promoted_at, i.promoted_memory_id
FROM staging_item i
JOIN staging_session s ON s.id = i.session_id
WHERE s.project_id = $1 AND s.repo_id = $2 AND s.branch = $3 AND s.status = 'open'
ORDER BY i.created_at DESC
`.trim();

// Tenant-scoped delete: item must belong to the caller's own open session.
// Using USING clause joins staging_session to enforce ownership boundary.
// $1=item_id  $2=project_id  $3=repo_id  $4=branch
const DISCARD_STAGING_ITEM_SQL = `
DELETE FROM staging_item i
USING staging_session s
WHERE i.id = $1 AND i.session_id = s.id
  AND s.project_id = $2 AND s.repo_id = $3 AND s.branch = $4 AND s.status = 'open'
`.trim();

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgStagingRepository implements StagingRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Lazy upsert of the open session for the tenant key (Decision 3).
   * Uses INSERT … ON CONFLICT DO NOTHING + re-SELECT to avoid advisory locks.
   * TTL bumped on both paths (new and existing session).
   */
  async findOrCreateOpenSession(tenant: TenantContext, openedBy: string): Promise<string> {
    const { projectId, repoId, branch } = tenant;
    const newId = ulid();

    // 1) Attempt create
    const insertResult = await this.pool.query<RawSessionIdRow>(
      FIND_OR_CREATE_SESSION_SQL,
      [newId, projectId, repoId, branch, openedBy],
    );

    let sessionId: string;
    if (insertResult.rows.length > 0) {
      // New session created
      sessionId = (insertResult.rows[0] as RawSessionIdRow).id;
    } else {
      // 2) Conflict: re-select the existing open session
      const selectResult = await this.pool.query<RawSessionIdRow>(
        SELECT_OPEN_SESSION_SQL,
        [projectId, repoId, branch],
      );
      // L3: guard against a race where the conflicted session was promoted/abandoned
      // between the INSERT and this SELECT, leaving rows[0] undefined.
      if (selectResult.rows[0] === undefined) {
        throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      }
      sessionId = selectResult.rows[0].id;
    }

    // 3) Sliding TTL bump (both paths)
    await this.pool.query(BUMP_SESSION_TTL_SQL, [sessionId]);

    return sessionId;
  }

  /**
   * Idempotent insert by (session_id, content_hash).
   * When the row already exists (same hash = same logical content) the
   * existing id + judge_state are returned with deduped:true.
   */
  async insertStagingItem(
    sessionId: string,
    p: InsertStagingItemParams,
  ): Promise<{ id: string; judgeState: StagingItemRow['judge_state']; deduped: boolean }> {
    const insertResult = await this.pool.query<RawItemInsertRow>(INSERT_STAGING_ITEM_SQL, [
      sessionId,           // $1
      p.op,                // $2
      p.type,              // $3
      p.title,             // $4
      p.summary,           // $5
      p.body,              // $6
      JSON.stringify(p.fields), // $7 — explicit serialization before ::jsonb cast
      p.contentHash,       // $8
      p.targetMemoryId,    // $9
      p.targetRevision,    // $10
      p.judgeState,        // $11
      p.authorIdentity,    // $12
    ]);

    if (insertResult.rows.length > 0) {
      const row = insertResult.rows[0] as RawItemInsertRow;
      return {
        id: row.id,
        judgeState: row.judge_state as StagingItemRow['judge_state'],
        deduped: false,
      };
    }

    // Dedup: re-select the pre-existing item
    const selectResult = await this.pool.query<RawItemInsertRow>(
      SELECT_STAGING_ITEM_BY_HASH_SQL,
      [sessionId, p.contentHash],
    );
    const row = selectResult.rows[0] as RawItemInsertRow;
    return {
      id: row.id,
      judgeState: row.judge_state as StagingItemRow['judge_state'],
      deduped: true,
    };
  }

  /**
   * Returns the caller's open-session items newest first.
   * Returns an empty array when no open session exists (no rows match).
   */
  async listStagingItems(tenant: TenantContext): Promise<StagingItemRow[]> {
    const { projectId, repoId, branch } = tenant;
    const result = await this.pool.query<RawStagingItemRow>(LIST_STAGING_ITEMS_SQL, [
      projectId,
      repoId,
      branch,
    ]);

    return result.rows.map((r) => ({
      id: r.id,
      op: r.op as StagingItemRow['op'],
      type: r.type as MemoryType,
      title: r.title,
      summary: r.summary,
      body: r.body,
      fields: r.fields,
      content_hash: r.content_hash,
      target_memory_id: r.target_memory_id,
      target_revision: r.target_revision,
      judge_state: r.judge_state as StagingItemRow['judge_state'],
      created_at: r.created_at,
      promoted_at: r.promoted_at,
      promoted_memory_id: r.promoted_memory_id,
    }));
  }

  /**
   * Deletes a staging item scoped to the caller's own open session.
   * Returns false (not an error) when the item is absent or belongs to a
   * different session — caller maps this to an opaque INVALID_REFERENCE.
   */
  async discardStagingItem(tenant: TenantContext, itemId: string): Promise<boolean> {
    const { projectId, repoId, branch } = tenant;
    const result = await this.pool.query(DISCARD_STAGING_ITEM_SQL, [
      itemId,
      projectId,
      repoId,
      branch,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
