/**
 * ReviewQueueRepository — read side of the human review queue (HU-07).
 *
 * The queue is C1's staging state, not a table. Every statement is scoped by
 * ss.project_id through the staging_session JOIN (staging_item has no project
 * column) and uses the same QUEUED predicate. Writes (approve / reject) live in
 * PgPromotionRepository so there is a single write path.
 *
 * Mirrors the other repositories: top-level SQL constants, $N parameters only,
 * raw rows mapped to typed rows.
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { DecisionCriterion } from '../judge/judge.js';
import type { SanitizeFlags } from './promotionRepository.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueFilter = 'all' | 'uncertain' | 'mandatory';

/** Queued items only, so judge_state is never 'rejected'. */
export type QueuedJudgeState = 'pending' | 'accepted' | 'uncertain';

export interface ReviewQueueRow {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  judge_state: QueuedJudgeState;
  judge_criterion: DecisionCriterion | null;
  judge_confidence: number | null;
  mandatory_review: boolean;
  origin_branch: string;
  origin_pr: number | null;
  /** display_name, else email, else the raw author identity. */
  author: string;
  created_at: Date;
}

export interface ReviewItemRow extends ReviewQueueRow {
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  content_hash: string;
  target_memory_id: string | null;
  target_revision: number | null;
  judge_reason: string | null;
  related_memory_id: string | null;
  sanitize_flags: SanitizeFlags;
  author_identity: string;
}

export interface ReviewQueueCounters {
  /** uncertain + mandatory */
  pending: number;
  /** queued and not mandatory_review */
  uncertain: number;
  /** queued and mandatory_review */
  mandatory: number;
  resolvedLast7Days: number;
}

export interface MemoryRefRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: 'active' | 'superseded' | 'deprecated';
  current_revision: number;
  origin_branch: string | null;
  origin_pr: number | null;
  updated_at: Date;
}

export interface ReviewQueueRepository {
  listQueue(
    projectId: string,
    q: { filter: QueueFilter; type: MemoryType | null; limit: number },
  ): Promise<{ rows: ReviewQueueRow[]; truncated: boolean }>;
  countQueue(projectId: string): Promise<ReviewQueueCounters>;
  /** Queued items only: a resolved, foreign or abandoned item gives null. */
  findQueuedItem(projectId: string, itemId: string): Promise<ReviewItemRow | null>;
  /** Project-scoped memory rows; [] issues no query. */
  findMemoryRefs(projectId: string, ids: string[]): Promise<MemoryRefRow[]>;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Queue membership for a staging_item `si` joined to its session `ss`.
 * Shared with PgPromotionRepository's review lock. A static fragment (no user
 * input is ever interpolated). `ss.status <> 'abandoned'` closes the race with
 * a remember() that inserts into a session being abandoned.
 */
export const QUEUED_PREDICATE = `si.promoted_at IS NULL AND si.reviewed_at IS NULL
  AND si.judge_state <> 'rejected'
  AND (si.judge_state = 'uncertain' OR si.mandatory_review)
  AND ss.status <> 'abandoned'`;

// $1 project_id  $2 filter  $3 type|null  $4 limit+1
const LIST_QUEUE_SQL = `
SELECT si.id, si.op, si.type, si.title, si.judge_state, si.judge_criterion, si.judge_confidence,
       si.mandatory_review, ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       COALESCE(u.display_name, u.email, si.author_identity) AS author, si.created_at
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
LEFT JOIN app_user u ON u.idp_subject = si.author_identity
WHERE ss.project_id = $1 AND ${QUEUED_PREDICATE}
  AND ($2::text = 'all' OR ($2::text = 'uncertain' AND NOT si.mandatory_review)
                        OR ($2::text = 'mandatory' AND si.mandatory_review))
  AND ($3::memory_type IS NULL OR si.type = $3::memory_type)
ORDER BY si.created_at ASC, si.id ASC
LIMIT $4
`.trim();

// $1 project_id — badge totals, independent of filter/type.
const COUNT_QUEUE_SQL = `
SELECT count(*) FILTER (WHERE q.queued)                                    AS pending,
       count(*) FILTER (WHERE q.queued AND NOT si.mandatory_review)        AS uncertain,
       count(*) FILTER (WHERE q.queued AND si.mandatory_review)            AS mandatory,
       count(*) FILTER (WHERE si.reviewed_at >= now() - interval '7 days') AS resolved_last_7_days
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
CROSS JOIN LATERAL (SELECT (${QUEUED_PREDICATE}) AS queued) q
WHERE ss.project_id = $1 AND (q.queued OR si.reviewed_at >= now() - interval '7 days')
`.trim();

// $1 project_id  $2 item_id
const FIND_QUEUED_ITEM_SQL = `
SELECT si.id, si.op, si.type, si.title, si.summary, si.body, si.fields, si.content_hash,
       si.target_memory_id, si.target_revision, si.judge_state, si.judge_reason,
       si.judge_criterion, si.judge_confidence, si.related_memory_id, si.mandatory_review,
       si.sanitize_flags, si.author_identity, si.created_at,
       ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       COALESCE(u.display_name, u.email, si.author_identity) AS author
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
LEFT JOIN app_user u ON u.idp_subject = si.author_identity
WHERE ss.project_id = $1 AND si.id = $2 AND ${QUEUED_PREDICATE}
`.trim();

// $1 project_id  $2 uuid[]
const FIND_MEMORY_REFS_SQL = `
SELECT id, type, title, summary, status, current_revision, origin_branch, origin_pr, updated_at
FROM memory WHERE project_id = $1 AND id = ANY($2::uuid[])
`.trim();

interface RawCounters {
  pending: string;
  uncertain: string;
  mandatory: string;
  resolved_last_7_days: string;
}

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgReviewQueueRepository implements ReviewQueueRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listQueue(
    projectId: string,
    q: { filter: QueueFilter; type: MemoryType | null; limit: number },
  ): Promise<{ rows: ReviewQueueRow[]; truncated: boolean }> {
    const { rows } = await this.pool.query<ReviewQueueRow>(LIST_QUEUE_SQL, [
      projectId,
      q.filter,
      q.type,
      q.limit + 1,
    ]);
    const truncated = rows.length > q.limit;
    return { rows: truncated ? rows.slice(0, q.limit) : rows, truncated };
  }

  async countQueue(projectId: string): Promise<ReviewQueueCounters> {
    const { rows } = await this.pool.query<RawCounters>(COUNT_QUEUE_SQL, [projectId]);
    const r = rows[0]!;
    // count(*) is bigint → pg returns a string.
    return {
      pending: Number(r.pending),
      uncertain: Number(r.uncertain),
      mandatory: Number(r.mandatory),
      resolvedLast7Days: Number(r.resolved_last_7_days),
    };
  }

  async findQueuedItem(projectId: string, itemId: string): Promise<ReviewItemRow | null> {
    const { rows } = await this.pool.query<ReviewItemRow>(FIND_QUEUED_ITEM_SQL, [
      projectId,
      itemId,
    ]);
    const r = rows[0];
    if (!r) return null;
    return { ...r, sanitize_flags: r.sanitize_flags ?? {} };
  }

  async findMemoryRefs(projectId: string, ids: string[]): Promise<MemoryRefRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<MemoryRefRow>(FIND_MEMORY_REFS_SQL, [projectId, ids]);
    return rows;
  }
}
