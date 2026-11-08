/**
 * LifecycleRepository — memory lifecycle writes (C4, HU-12, HU-11.4).
 *
 * Every statement is a single self-contained SQL statement (a guarded UPDATE
 * or a data-modifying CTE that locks, updates and writes the revision), so no
 * multi-statement transaction is needed. Parameterized $N only. The retire
 * reason is stored only in memory.retired_reason, never in the revision.
 */

import type pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';

export type MemoryStatus = 'active' | 'superseded' | 'deprecated' | 'pending_revalidation';

export interface MemoryListRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  current_revision: number;
  origin_branch: string | null;
  origin_pr: number | null;
  revalidate_at: Date | null;
  updated_at: Date;
}

export interface LifecycleRepository {
  listMemories(
    projectId: string,
    q: { status: MemoryStatus; limit: number },
  ): Promise<{ rows: MemoryListRow[]; truncated: boolean }>;
  /** pending_revalidation → active with a fresh deadline; null when no such row (404). */
  confirm(
    projectId: string,
    memoryId: string,
  ): Promise<{ memoryId: string; revalidateAt: Date | null } | null>;
  /** active|pending → deprecated + deprecate revision; null when no such row (404). */
  retire(
    projectId: string,
    memoryId: string,
    reason: string,
    actorIdentity: string,
  ): Promise<{ memoryId: string; revision: number } | null>;
  /** Every active|pending row of the project with this origin_pr, in one statement. */
  retireByPr(
    projectId: string,
    originPr: number,
    reason: string,
    actorIdentity: string,
  ): Promise<{ retired: number; memoryIds: string[] }>;
  /** Platform job: active non-outcome rows past revalidate_at → pending_revalidation. */
  sweepExpired(): Promise<Array<{ projectId: string; count: number }>>;
}

// ---------------------------------------------------------------------------
// SQL — every statement but the platform sweep carries project_id = $1.
// ---------------------------------------------------------------------------

// $1 project_id  $2 status  $3 limit+1 (uses ix_memory_proj_status)
const LIST_SQL = `
SELECT id, type, title, summary, status, current_revision, origin_branch, origin_pr,
       revalidate_at, updated_at
FROM memory
WHERE project_id = $1 AND status = $2::memory_status
ORDER BY revalidate_at ASC NULLS LAST, id ASC
LIMIT $3
`.trim();

// $1 project_id  $2 memory_id  $3 revalidation_days
// The WHERE clause is the guard: active, deprecated, superseded or foreign → 0 rows.
// Content is unchanged: no revision, no updated_at bump, so handles stay valid.
const CONFIRM_SQL = `
UPDATE memory
SET status = 'active',
    revalidate_at = CASE WHEN type = 'outcome' THEN NULL
                         ELSE now() + make_interval(days => $3::int) END,
    reviewed_at = now()
WHERE id = $2 AND project_id = $1 AND status = 'pending_revalidation'
RETURNING id, revalidate_at
`.trim();

// Shared tail of RETIRE_ONE / RETIRE_BY_PR: flips the locked rows and writes one
// 'deprecate' revision per row from the post-update RETURNING (new revision,
// unchanged content). $1 project_id  $3 reason  $4 actor_identity
const RETIRE_TAIL_SQL = `
upd AS (
  UPDATE memory m
  SET status = 'deprecated', retired_reason = $3::text, revalidate_at = NULL,
      current_revision = m.current_revision + 1, updated_at = now()
  FROM target t
  WHERE m.id = t.id AND m.project_id = $1
  RETURNING m.id, m.current_revision, m.title, m.summary, m.body, m.fields, m.type, m.content_hash
)
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
SELECT id, current_revision, 'deprecate', title, summary, body, fields, type,
       content_hash, $4::text, NULL
FROM upd
RETURNING memory_id, revision_no
`.trim();

// $1 project_id  $2 memory_id  $3 reason  $4 actor_identity
const RETIRE_ONE_SQL = `
WITH target AS (
  SELECT id FROM memory
  WHERE project_id = $1 AND id = $2::uuid
    AND status IN ('active', 'pending_revalidation')
  ORDER BY id
  FOR UPDATE
),
${RETIRE_TAIL_SQL}
`.trim();

// $1 project_id  $2 origin_pr  $3 reason  $4 actor_identity (uses ix_memory_proj_origin_pr)
const RETIRE_BY_PR_SQL = `
WITH target AS (
  SELECT id FROM memory
  WHERE project_id = $1 AND origin_pr = $2::int
    AND status IN ('active', 'pending_revalidation')
  ORDER BY id
  FOR UPDATE
),
${RETIRE_TAIL_SQL}
`.trim();

// Platform job, project-agnostic. Strict "<": a row due exactly now goes next run.
// revalidate_at and updated_at stay as they are (content unchanged).
const SWEEP_SQL = `
WITH swept AS (
  UPDATE memory
  SET status = 'pending_revalidation'
  WHERE status = 'active' AND type <> 'outcome'
    AND revalidate_at IS NOT NULL AND revalidate_at < now()
  RETURNING project_id
)
SELECT project_id, count(*)::int AS n FROM swept GROUP BY project_id
`.trim();

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export interface LifecycleRepositoryOptions {
  /** REVALIDATION_DAYS: the new deadline set by confirm. */
  revalidationDays: number;
}

export class PgLifecycleRepository implements LifecycleRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: LifecycleRepositoryOptions,
  ) {
    // Defence in depth for tests and scripts that bypass loadConfig.
    if (!Number.isInteger(opts.revalidationDays) || opts.revalidationDays < 1) {
      throw new Error('PgLifecycleRepository: revalidationDays must be an integer >= 1');
    }
  }

  async listMemories(
    projectId: string,
    q: { status: MemoryStatus; limit: number },
  ): Promise<{ rows: MemoryListRow[]; truncated: boolean }> {
    const { rows } = await this.pool.query<MemoryListRow>(LIST_SQL, [
      projectId,
      q.status,
      q.limit + 1,
    ]);
    const truncated = rows.length > q.limit;
    return { rows: truncated ? rows.slice(0, q.limit) : rows, truncated };
  }

  async confirm(
    projectId: string,
    memoryId: string,
  ): Promise<{ memoryId: string; revalidateAt: Date | null } | null> {
    const { rows } = await this.pool.query<{ id: string; revalidate_at: Date | null }>(
      CONFIRM_SQL,
      [projectId, memoryId, this.opts.revalidationDays],
    );
    const r = rows[0];
    return r ? { memoryId: r.id, revalidateAt: r.revalidate_at } : null;
  }

  async retire(
    projectId: string,
    memoryId: string,
    reason: string,
    actorIdentity: string,
  ): Promise<{ memoryId: string; revision: number } | null> {
    const { rows } = await this.pool.query<{ memory_id: string; revision_no: number }>(
      RETIRE_ONE_SQL,
      [projectId, memoryId, reason, actorIdentity],
    );
    const r = rows[0];
    return r ? { memoryId: r.memory_id, revision: r.revision_no } : null;
  }

  async retireByPr(
    projectId: string,
    originPr: number,
    reason: string,
    actorIdentity: string,
  ): Promise<{ retired: number; memoryIds: string[] }> {
    const { rows } = await this.pool.query<{ memory_id: string; revision_no: number }>(
      RETIRE_BY_PR_SQL,
      [projectId, originPr, reason, actorIdentity],
    );
    return { retired: rows.length, memoryIds: rows.map((r) => r.memory_id) };
  }

  async sweepExpired(): Promise<Array<{ projectId: string; count: number }>> {
    const { rows } = await this.pool.query<{ project_id: string; n: number }>(SWEEP_SQL);
    return rows.map((r) => ({ projectId: r.project_id, count: r.n }));
  }
}
