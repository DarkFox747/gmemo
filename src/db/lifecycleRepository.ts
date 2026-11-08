/**
 * LifecycleRepository — memory lifecycle writes (C4, HU-12, HU-11.4).
 *
 * Every write is a single self-contained SQL statement (a guarded UPDATE or a
 * data-modifying CTE that locks, updates and writes the revision). When the
 * caller passes an `audit` hook (C11: the REST routes), the statement and the
 * hook run in one BEGIN…COMMIT on the same client, so the access_log row
 * commits with the change and a hook failure rolls it back. Parameterized $N
 * only. The retire reason is stored only in memory.retired_reason, never in
 * the revision.
 */

import type pg from 'pg';
import type { TxnAudit } from './authRepository.js';
import { logger } from '../observability/logger.js';
import { AppError, ErrorCode } from '../errors/appError.js';

export interface ConfirmResult {
  memoryId: string;
  revalidateAt: Date | null;
}

export interface RetireResult {
  memoryId: string;
  revision: number;
}

export interface RetireByPrResult {
  retired: number;
  memoryIds: string[];
}

/** Writes only: browsing (list, detail, revisions) lives in MemoryAdminRepository (C5). */
export interface LifecycleRepository {
  /**
   * pending_revalidation → active with a fresh deadline; null when no such row
   * (404, nothing written, `audit` not run).
   */
  confirm(
    projectId: string,
    memoryId: string,
    audit?: TxnAudit<ConfirmResult>,
  ): Promise<ConfirmResult | null>;
  /** active|pending → deprecated + deprecate revision; null when no such row (404, no audit). */
  retire(
    projectId: string,
    memoryId: string,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireResult>,
  ): Promise<RetireResult | null>;
  /** Every active|pending row of the project with this origin_pr, in one statement (0 is audited). */
  retireByPr(
    projectId: string,
    originPr: number,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireByPrResult>,
  ): Promise<RetireByPrResult>;
  /** Platform job: active non-outcome rows past revalidate_at → pending_revalidation. */
  sweepExpired(): Promise<Array<{ projectId: string; count: number }>>;
}

// ---------------------------------------------------------------------------
// SQL — every statement but the platform sweep carries project_id = $1.
// ---------------------------------------------------------------------------

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

  async confirm(
    projectId: string,
    memoryId: string,
    audit?: TxnAudit<ConfirmResult>,
  ): Promise<ConfirmResult | null> {
    return this.writeAudited(
      CONFIRM_SQL,
      [projectId, memoryId, this.opts.revalidationDays],
      (rows: Array<{ id: string; revalidate_at: Date | null }>) => {
        const r = rows[0];
        return r ? { memoryId: r.id, revalidateAt: r.revalidate_at } : null;
      },
      audit,
    );
  }

  async retire(
    projectId: string,
    memoryId: string,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireResult>,
  ): Promise<RetireResult | null> {
    return this.writeAudited(
      RETIRE_ONE_SQL,
      [projectId, memoryId, reason, actorIdentity],
      (rows: Array<{ memory_id: string; revision_no: number }>) => {
        const r = rows[0];
        return r ? { memoryId: r.memory_id, revision: r.revision_no } : null;
      },
      audit,
    );
  }

  async retireByPr(
    projectId: string,
    originPr: number,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireByPrResult>,
  ): Promise<RetireByPrResult> {
    const r = await this.writeAudited(
      RETIRE_BY_PR_SQL,
      [projectId, originPr, reason, actorIdentity],
      (rows: Array<{ memory_id: string; revision_no: number }>) => ({
        retired: rows.length,
        memoryIds: rows.map((row) => row.memory_id),
      }),
      audit,
    );
    // The mapper never returns null for a bulk retire; guard the type, not a real path.
    if (r === null) throw new AppError(ErrorCode.INTERNAL);
    return r;
  }

  /**
   * Runs one write statement; with an `audit` hook, statement + hook share one
   * transaction (null result → rollback, nothing to audit). Without a hook the
   * statement runs alone on the pool, as before C11.
   */
  private async writeAudited<Row extends pg.QueryResultRow, R>(
    sql: string,
    params: unknown[],
    map: (rows: Row[]) => R | null,
    audit: TxnAudit<R> | undefined,
  ): Promise<R | null> {
    if (!audit) {
      const { rows } = await this.pool.query<Row>(sql, params);
      return map(rows);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(sql, params);
      const result = map(rows);
      if (result === null) {
        await client.query('ROLLBACK');
        return null;
      }
      await audit(client, result);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        // The original error is the one surfaced.
        logger.warn('[lifecycle] rollback failed', {
          errorName: rollbackErr instanceof Error ? rollbackErr.name : 'unknown',
        });
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async sweepExpired(): Promise<Array<{ projectId: string; count: number }>> {
    const { rows } = await this.pool.query<{ project_id: string; n: number }>(SWEEP_SQL);
    return rows.map((r) => ({ projectId: r.project_id, count: r.n }));
  }
}
