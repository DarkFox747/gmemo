/**
 * InsightsRepository — read-only governance insights for the web (C12):
 *
 *   getDashboard   Inicio: memory/queue/quarantine counts and the judge section
 *                  (30-day outcomes, stored human labels, live FP/FN indicators)
 *   listActivity   Actividad: state-changing access_log events, newest first,
 *                  keyset on access_log.id
 *   listStaging    Área de preparación: agent staging sessions + capped items
 *
 * Invariants: every statement binds $1 = project_id and every joined row is
 * re-scoped to it (an id of another project inside an audit detail never
 * resolves); parameters only; explicit column lists. The activity query never
 * projects query_hash, actor_identity, session_id or the raw detail — only
 * allow-listed detail keys, type-guarded in insightsMapping.ts. Staging titles
 * are PII-masked (open-session items have not been through promotion yet);
 * summaries, bodies, fields and authors are never selected. Server-owned
 * restore/ and web/ sessions are excluded from staging and from judge labels.
 */

import type pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { DecisionCriterion } from '../judge/judge.js';
import { QUARANTINE_CRITERIA, type QuarantineCriterion } from '../quarantine/reason.js';
import { MEMORY_TYPES } from '../mcp/tools/schemas.js';
import { maskPii } from '../security/piiMask.js';
import type {
  ActivityCategory,
  ActivityListDto,
  DashboardDto,
  StagingItemState,
  StagingOverviewDto,
  StagingOverviewItemDto,
  StagingSessionDto,
} from '../http/api/types.js';
import type { MemoryStatus } from './memoryAdminRepository.js';
import { QUEUED_PREDICATE } from './reviewQueueRepository.js';
import {
  CLOSED_SESSION_DAYS,
  WINDOW_DAYS,
  judgeRates,
  toActivityEvent,
  type RawActivityRow,
} from './insightsMapping.js';

export interface ActivityQuery {
  category: ActivityCategory | null;
  /** A validated positive int8 (parseActivityCursor), or null for the first page. */
  cursor: string | null;
  limit: number;
}

export interface StagingQuery {
  status: 'open' | 'closed';
  limit: number;
}

export interface InsightsRepository {
  getDashboard(projectId: string): Promise<DashboardDto>;
  listActivity(projectId: string, q: ActivityQuery): Promise<ActivityListDto>;
  listStaging(projectId: string, q: StagingQuery): Promise<StagingOverviewDto>;
}

/** At most this many items per staging session (newest first). */
export const STAGING_ITEMS_CAP = 100;

const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'active',
  'pending_revalidation',
  'superseded',
  'deprecated',
];

const NOT_RESERVED = `NOT starts_with(ss.branch, 'restore/') AND NOT starts_with(ss.branch, 'web/')`;

/** Judge criteria of a judge rejection (rejected without one = pipeline block or apply-time dedup). */
const JUDGE_REJECTED = `COALESCE(si.judge_criterion IN ('duplication','specificity','security_second_layer'), false)`;

/** No judge evaluation at all: R1 stale target, or the judge/its context unavailable (fail closed). */
const NOT_EVALUATED = `COALESCE(si.judge_criterion = 'stale_target'
  OR si.judge_reason IN ('judge_unavailable','judge_context_unavailable'), false)`;

// --- Inicio --------------------------------------------------------------

// $1 project_id
const MEMORY_COUNTS_SQL = `
SELECT status::text AS status, type::text AS type, count(*)::int AS n
FROM memory
WHERE project_id = $1
GROUP BY status, type`;

// $1 project_id — identical to the review-queue badge counters.
const QUEUE_SQL = `
SELECT (count(*) FILTER (WHERE NOT si.mandatory_review))::int AS uncertain,
       (count(*) FILTER (WHERE si.mandatory_review))::int     AS mandatory
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
WHERE ss.project_id = $1 AND ${QUEUED_PREDICATE}`;

// $1 project_id
const QUARANTINE_ACTIVE_SQL = `
SELECT criterion::text AS criterion, count(*)::int AS n
FROM quarantine
WHERE project_id = $1 AND restored_at IS NULL
GROUP BY criterion`;

// $1 project_id  $2 window days — items of agent sessions finalized inside the window.
const OUTCOMES_SQL = `
SELECT
  (count(*) FILTER (WHERE si.judge_state = 'accepted'))::int                          AS accepted,
  (count(*) FILTER (WHERE si.judge_state = 'uncertain' AND NOT ne.v))::int            AS uncertain,
  (count(*) FILTER (WHERE si.judge_state = 'rejected' AND jr.v))::int                 AS rejected,
  (count(*) FILTER (WHERE si.judge_state = 'rejected' AND NOT jr.v))::int             AS pipeline_blocked,
  (count(*) FILTER (WHERE si.judge_state = 'uncertain' AND ne.v))::int                AS not_evaluated,
  (count(*) FILTER (WHERE si.judge_state = 'accepted' AND si.promoted_at IS NOT NULL
                      AND si.reviewed_at IS NULL))::int                               AS auto_applied,
  (count(*) FILTER (WHERE si.judge_state = 'rejected' AND jr.v AND NOT EXISTS (
      SELECT 1 FROM quarantine rq
      WHERE rq.origin_item_id = si.id AND rq.project_id = ss.project_id
        AND rq.restored_at IS NOT NULL)))::int                                        AS judge_rejected_unrestored
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
CROSS JOIN LATERAL (SELECT ${JUDGE_REJECTED} AS v) jr
CROSS JOIN LATERAL (SELECT ${NOT_EVALUATED} AS v) ne
WHERE ss.project_id = $1
  AND ss.promoted_at >= now() - make_interval(days => $2::int)
  AND si.judge_state <> 'pending'
  AND ${NOT_RESERVED}`;

// $1 project_id  $2 window days — review labels by label time, judge-evaluated items only.
const LABELS_SQL = `
SELECT
  (count(*) FILTER (WHERE si.judge_state = 'uncertain' AND si.review_decision = 'approved'))::int AS uncertain_approved,
  (count(*) FILTER (WHERE si.judge_state = 'uncertain' AND si.review_decision = 'rejected'))::int AS uncertain_rejected,
  (count(*) FILTER (WHERE si.judge_state = 'accepted' AND si.review_decision = 'approved'))::int  AS accepted_approved,
  (count(*) FILTER (WHERE si.judge_state = 'accepted' AND si.review_decision = 'rejected'))::int  AS accepted_rejected
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
WHERE ss.project_id = $1
  AND si.reviewed_at >= now() - make_interval(days => $2::int)
  AND si.review_decision IS NOT NULL
  AND si.judge_state IN ('accepted','uncertain')
  AND NOT ${NOT_EVALUATED}
  AND ${NOT_RESERVED}`;

// $1 project_id  $2 window days — restore labels live on the quarantine row.
const RESTORES_SQL = `
SELECT criterion::text AS criterion, count(*)::int AS n
FROM quarantine
WHERE project_id = $1 AND restored_at >= now() - make_interval(days => $2::int)
GROUP BY criterion`;

// --- Actividad -----------------------------------------------------------

const UUID_RE = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/** Mirrors ACTIVITY_CATEGORY (insightsMapping.ts); NULL = 'other' (only in the unfiltered list). */
const CATEGORY_CASE = `CASE
  WHEN al.action = 'stage' AND al.detail->>'tool' IN ('remember','discard_staged') THEN 'staging'
  WHEN al.action = 'promote' AND al.actor_kind = 'ci' THEN 'promotion'
  WHEN al.action = 'delete' AND al.detail->>'event' = 'closed_unmerged' THEN 'promotion'
  WHEN al.action = 'update' AND al.detail->>'api' IN ('review_queue.approve','review_queue.reject') THEN 'review'
  WHEN al.action = 'update' AND al.detail->>'api' = 'quarantine.restore' THEN 'quarantine'
  WHEN al.action = 'update' AND al.detail->>'api' IN
    ('memory.create','memory.amend','memory.confirm','memory.retire','memory.retire_by_pr') THEN 'memory'
END`;

// $1 project_id  $2 category|null  $3 cursor id|null  $4 limit+1
// Job rows (project_id NULL, per-project counts in detail.detail) appear only
// when they touched this project, with this project's count only.
const ACTIVITY_SQL = `
WITH page AS (
  ( SELECT al.id, al.ts, al.actor_kind, al.action, al.actor_identity, al.memory_id, al.session_id,
           al.detail, NULL::jsonb AS job_count
    FROM access_log al
    WHERE al.project_id = $1 AND al.action <> 'read'
      AND ($3::bigint IS NULL OR al.id < $3::bigint)
      AND ($2::text IS NULL OR $2::text = ${CATEGORY_CASE})
    ORDER BY al.id DESC
    LIMIT $4 )
  UNION ALL
  ( SELECT al.id, al.ts, al.actor_kind, al.action, al.actor_identity, NULL::uuid, NULL::text,
           al.detail, al.detail->'detail'->($1::text)
    FROM access_log al
    WHERE al.project_id IS NULL AND al.actor_kind = 'system' AND al.action = 'admin'
      AND jsonb_typeof(al.detail->'detail') = 'object'
      AND (al.detail->'detail') ? ($1::text)
      AND ($2::text IS NULL OR $2::text = 'jobs')
      AND ($3::bigint IS NULL OR al.id < $3::bigint)
    ORDER BY al.id DESC
    LIMIT $4 )
)
SELECT p.id::text AS id, p.ts, p.actor_kind::text AS actor_kind, p.action::text AS action,
       jsonb_build_object(
         'api', p.detail->'api', 'tool', p.detail->'tool', 'event', p.detail->'event',
         'job', p.detail->'job', 'branch', p.detail->'branch', 'prNumber', p.detail->'prNumber',
         'applied', p.detail->'applied', 'uncertain', p.detail->'uncertain',
         'quarantined', p.detail->'quarantined', 'discarded', p.detail->'discarded',
         'outcome', p.detail->'outcome', 'originPr', p.detail->'originPr',
         'resultCount', p.detail->'resultCount') AS detail,
       p.job_count,
       u.display_name AS actor_name,
       ss.branch AS session_branch,
       m.type::text AS m_type, m.title AS m_title,
       si.type AS i_type, si.title AS i_title,
       q.type::text AS q_type, q.title AS q_title
FROM page p
LEFT JOIN app_user u ON p.actor_kind IN ('user','agent') AND u.idp_subject = p.actor_identity
LEFT JOIN staging_session ss ON ss.id = p.session_id AND ss.project_id = $1
LEFT JOIN memory m ON m.id = p.memory_id AND m.project_id = $1
LEFT JOIN LATERAL (
  SELECT s2.type::text AS type, s2.title
  FROM staging_item s2
  JOIN staging_session ss2 ON ss2.id = s2.session_id AND ss2.project_id = $1
  WHERE s2.id = CASE WHEN p.detail->>'itemId' ~* ${UUID_RE}
                     THEN (p.detail->>'itemId')::uuid END
) si ON true
LEFT JOIN quarantine q ON q.project_id = $1
  AND q.id = CASE WHEN p.detail->>'quarantineId' ~* ${UUID_RE}
                  THEN (p.detail->>'quarantineId')::uuid END
ORDER BY p.id DESC
LIMIT $4`;

// --- Área de preparación -------------------------------------------------

/** slug, else the remote host/path: userinfo (https://user:token@ or git@) is stripped. */
const REPO_LABEL = `COALESCE(r.slug,
  regexp_replace(regexp_replace(r.remote_url, '^([a-z][a-z0-9+.-]*://)[^/@]*@', '\\1', 'i'),
                 '^[^/@:]+@', ''))`;

const CLOSED_AT = `COALESCE(ss.promoted_at, ss.last_activity_at)`;

// Sessions in status 'validating' appear in neither tab: they are in flight, neither open nor closed.
// $1 project_id  $2 'open'|'closed'  $3 limit+1  $4 closed window days
const SESSIONS_SQL = `
SELECT ss.id, ss.repo_id, ${REPO_LABEL} AS repo_label, ss.branch,
       ss.status::text AS status, ss.pr_number, u.display_name AS opened_by,
       ss.created_at, ss.last_activity_at, ss.expires_at,
       CASE WHEN ss.status = 'open' THEN NULL ELSE ${CLOSED_AT} END AS closed_at,
       (SELECT count(*)::int FROM staging_item c WHERE c.session_id = ss.id) AS item_count
FROM staging_session ss
JOIN repo r ON r.id = ss.repo_id AND r.project_id = ss.project_id
LEFT JOIN app_user u ON u.idp_subject = ss.opened_by
WHERE ss.project_id = $1
  AND ${NOT_RESERVED}
  AND ( ($2::text = 'open' AND ss.status = 'open')
     OR ($2::text = 'closed'
         AND ss.status IN ('promoted','partially_promoted','rejected','abandoned')
         AND ${CLOSED_AT} >= now() - make_interval(days => $4::int)) )
ORDER BY CASE WHEN ss.status = 'open' THEN ss.last_activity_at ELSE ${CLOSED_AT} END DESC,
         ss.id DESC
LIMIT $3`;

// $1 project_id  $2 session ids  $3 per-session cap
const ITEMS_SQL = `
SELECT id, session_id, op, type, title, judge_state, judge_criterion, mandatory_review,
       created_at, state
FROM (
  SELECT si.id, si.session_id, si.op::text AS op, si.type::text AS type, si.title,
         si.judge_state::text AS judge_state, si.judge_criterion, si.mandatory_review,
         si.created_at,
         CASE WHEN si.promoted_at IS NOT NULL      THEN 'applied'
              WHEN si.review_decision = 'rejected' THEN 'review_rejected'
              WHEN si.judge_state = 'rejected'     THEN 'quarantined'
              WHEN (${QUEUED_PREDICATE})           THEN 'queued'
              ELSE 'staged' END AS state,
         row_number() OVER (PARTITION BY si.session_id
                            ORDER BY si.created_at DESC, si.id DESC) AS rn
  FROM staging_item si
  JOIN staging_session ss ON ss.id = si.session_id
  WHERE ss.project_id = $1 AND si.session_id = ANY($2::text[])
) x
WHERE rn <= $3
ORDER BY session_id, created_at DESC, id DESC`;

// --- Raw rows ------------------------------------------------------------

interface MemoryCountRow {
  status: MemoryStatus;
  type: MemoryType;
  n: number;
}
interface QueueRow {
  uncertain: number;
  mandatory: number;
}
interface OutcomesRow {
  accepted: number;
  uncertain: number;
  rejected: number;
  pipeline_blocked: number;
  not_evaluated: number;
  auto_applied: number;
  judge_rejected_unrestored: number;
}
interface LabelsRow {
  uncertain_approved: number;
  uncertain_rejected: number;
  accepted_approved: number;
  accepted_rejected: number;
}
interface SessionRow {
  id: string;
  repo_id: string;
  repo_label: string;
  branch: string;
  status: StagingSessionDto['status'];
  pr_number: number | null;
  opened_by: string | null;
  created_at: Date;
  last_activity_at: Date;
  expires_at: Date | null;
  closed_at: Date | null;
  item_count: number;
}
interface ItemRow {
  id: string;
  session_id: string;
  op: StagingOverviewItemDto['op'];
  type: MemoryType;
  title: string;
  judge_state: StagingOverviewItemDto['judgeState'];
  judge_criterion: DecisionCriterion | null;
  mandatory_review: boolean;
  created_at: Date;
  state: StagingItemState;
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function byCriterion(rows: Array<{ criterion: string | null; n: number }>): {
  total: number;
  counts: Record<QuarantineCriterion, number>;
} {
  const counts = zeroed(QUARANTINE_CRITERIA);
  let total = 0;
  for (const r of rows) {
    total += r.n;
    if (r.criterion !== null && (QUARANTINE_CRITERIA as readonly string[]).includes(r.criterion)) {
      counts[r.criterion as QuarantineCriterion] += r.n;
    }
  }
  return { total, counts };
}

export class PgInsightsRepository implements InsightsRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async getDashboard(projectId: string): Promise<DashboardDto> {
    const w = [projectId, WINDOW_DAYS];
    // Sequential on purpose: one dashboard call must not burst six pool connections.
    const memories = await this.pool.query<MemoryCountRow>(MEMORY_COUNTS_SQL, [projectId]);
    const queue = await this.pool.query<QueueRow>(QUEUE_SQL, [projectId]);
    const quarantine = await this.pool.query<{ criterion: string | null; n: number }>(
      QUARANTINE_ACTIVE_SQL,
      [projectId],
    );
    const outcomes = await this.pool.query<OutcomesRow>(OUTCOMES_SQL, w);
    const labels = await this.pool.query<LabelsRow>(LABELS_SQL, w);
    const restores = await this.pool.query<{ criterion: string | null; n: number }>(
      RESTORES_SQL,
      w,
    );

    const byStatus = zeroed(MEMORY_STATUSES);
    const activeByType = zeroed(MEMORY_TYPES);
    let total = 0;
    for (const r of memories.rows) {
      total += r.n;
      if (r.status in byStatus) byStatus[r.status] += r.n;
      if (r.status === 'active' && r.type in activeByType) activeByType[r.type] += r.n;
    }

    const q = queue.rows[0]!;
    const active = byCriterion(quarantine.rows);
    const o = outcomes.rows[0]!;
    const l = labels.rows[0]!;
    const restored = byCriterion(restores.rows).counts;
    const labelCounts = {
      uncertainApproved: l.uncertain_approved,
      uncertainRejected: l.uncertain_rejected,
      acceptedApproved: l.accepted_approved,
      acceptedRejected: l.accepted_rejected,
      restoredFromJudge: restored.judge,
    };

    return {
      generatedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      memories: { total, byStatus, activeByType },
      queue: { pending: q.uncertain + q.mandatory, uncertain: q.uncertain, mandatory: q.mandatory },
      quarantine: { active: active.total, byCriterion: active.counts },
      judge: {
        outcomes: {
          accepted: o.accepted,
          uncertain: o.uncertain,
          rejected: o.rejected,
          pipelineBlocked: o.pipeline_blocked,
          notEvaluated: o.not_evaluated,
        },
        labels: labelCounts,
        restoredOther: { pipeline: restored.pipeline, humanReview: restored.human_review },
        unlabeled: {
          autoApplied: o.auto_applied,
          judgeRejectedNotRestored: o.judge_rejected_unrestored,
        },
        ...judgeRates(labelCounts),
      },
    };
  }

  async listActivity(projectId: string, q: ActivityQuery): Promise<ActivityListDto> {
    const { rows } = await this.pool.query<RawActivityRow>(ACTIVITY_SQL, [
      projectId,
      q.category,
      q.cursor,
      q.limit + 1,
    ]);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(toActivityEvent),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }

  async listStaging(projectId: string, q: StagingQuery): Promise<StagingOverviewDto> {
    const sessions = await this.pool.query<SessionRow>(SESSIONS_SQL, [
      projectId,
      q.status,
      q.limit + 1,
      CLOSED_SESSION_DAYS,
    ]);
    const truncated = sessions.rows.length > q.limit;
    const page = sessions.rows.slice(0, q.limit);
    if (page.length === 0) return { sessions: [], truncated };

    const items = await this.pool.query<ItemRow>(ITEMS_SQL, [
      projectId,
      page.map((s) => s.id),
      STAGING_ITEMS_CAP,
    ]);
    const bySession = new Map<string, StagingOverviewItemDto[]>();
    for (const i of items.rows) {
      const list = bySession.get(i.session_id) ?? [];
      list.push({
        id: i.id,
        op: i.op,
        type: i.type,
        title: maskPii(i.title).text,
        judgeState: i.judge_state,
        criterion: i.judge_criterion,
        mandatoryReview: i.mandatory_review,
        state: i.state,
        createdAt: i.created_at.toISOString(),
      });
      bySession.set(i.session_id, list);
    }

    return {
      truncated,
      sessions: page.map((s) => ({
        id: s.id,
        repo: { id: s.repo_id, label: s.repo_label },
        branch: s.branch,
        status: s.status,
        prNumber: s.pr_number,
        openedBy: s.opened_by,
        createdAt: s.created_at.toISOString(),
        lastActivityAt: s.last_activity_at.toISOString(),
        expiresAt: s.expires_at ? s.expires_at.toISOString() : null,
        closedAt: s.closed_at ? s.closed_at.toISOString() : null,
        itemCount: s.item_count,
        items: bySession.get(s.id) ?? [],
        itemsTruncated: s.item_count > STAGING_ITEMS_CAP,
      })),
    };
  }
}
