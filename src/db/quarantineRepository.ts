/**
 * QuarantineRepository — reads, restore claim and retention purge of the
 * quarantine table (C3, HU-10).
 *
 * Every API statement is scoped by q.project_id. Active rows match
 * `restored_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, so an
 * expired row is gone from the API even before the purge job runs. Non-admin
 * viewers only ever reach their own rows (`author_identity = subject`) through an
 * explicit is_admin boolean — never through a "null subject means everyone" rule.
 *
 * Parameterized $N SQL only; the excerpt is cut in SQL from the already-redacted body.
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { QuarantineCriterion, QuarantineReasonCode } from '../quarantine/reason.js';
import { NON_RESTORABLE_REASON_CODES } from '../quarantine/reason.js';
import { REDACTED_TOKEN } from '../security/secretRedact.js';
import { computeContentHash } from '../security/hash.js';
import { logger } from '../observability/logger.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuarantineViewer {
  isAdmin: boolean;
  /** principal.subject (= app_user.idp_subject = quarantine.author_identity). */
  subject: string;
}

type Op = 'add' | 'amend' | 'supersede' | 'deprecate';

export interface QuarantineListRow {
  id: string;
  reasonCode: QuarantineReasonCode | null;
  criterion: QuarantineCriterion | null;
  op: Op;
  type: MemoryType;
  title: string;
  excerpt: string;
  quarantinedAt: Date;
  daysUntilExpiry: number | null;
}

export interface QuarantineRelatedRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: 'active' | 'superseded' | 'deprecated';
  version: number;
  originBranch: string | null;
  originPr: number | null;
  updatedAt: Date;
}

export interface QuarantineDetailRow extends QuarantineListRow {
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  judgeReason: string;
  expiresAt: Date | null;
  author: string;
  originBranch: string | null;
  originPr: number | null;
  related: QuarantineRelatedRow | null;
}

export interface RestoreClaimInput {
  projectId: string;
  quarantineId: string;
  /** app_user.id of the restoring project_admin (quarantine.restored_by). */
  restoredByUserId: string;
  /** idp_subject of the restorer (staging_session.opened_by). */
  openedBy: string;
}

export type RestoreClaim =
  | { status: 'not_found' }
  | {
      status: 'claimed';
      sessionId: string;
      itemId: string;
      repoId: string;
      /** 'restore/<quarantine id>'. */
      branch: string;
      /** PR of the origin session, when it still exists. */
      originPr: number | null;
    };

/** The committed claim to undo after a failed restore (ids from RestoreClaim). */
export interface RestoreClaimRelease {
  projectId: string;
  quarantineId: string;
  sessionId: string;
  itemId: string;
}

export interface QuarantineRepository {
  list(
    projectId: string,
    v: QuarantineViewer,
    q: { reason: QuarantineReasonCode | null; limit: number },
  ): Promise<{ rows: QuarantineListRow[]; truncated: boolean }>;
  findVisible(
    projectId: string,
    v: QuarantineViewer,
    id: string,
  ): Promise<QuarantineDetailRow | null>;
  /**
   * One transaction: lock the active, rebuildable row of the project whose repo
   * still exists → open session `restore/<id>` → pending item with the ORIGINAL
   * author → restored_* label. First writer wins; anything else → not_found,
   * including redacted rows (SEC-L3) and a taken `restore/<id>` slot (SEC-L2).
   */
  claimForRestore(i: RestoreClaimInput): Promise<RestoreClaim>;
  /**
   * Un-claim after a restore whose pipeline failed (C11, backlog E4 #1): one
   * statement abandons the open `restore/<id>` session and clears the
   * restored_* label, so the row is active again and a retry can claim it.
   * Only while the claimed item has no terminal write (not applied, quarantined
   * or queued): a committed restore is never un-claimed. True when released.
   */
  releaseRestoreClaim(r: RestoreClaimRelease): Promise<boolean>;
  /** Platform job: deletes rows with expires_at < now(); counts per project. */
  purgeExpired(): Promise<Array<{ projectId: string; count: number }>>;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const DAYS_UNTIL_EXPIRY = `
CASE WHEN q.expires_at IS NULL THEN NULL
     ELSE GREATEST(0, ceil(extract(epoch FROM (q.expires_at - now())) / 86400))::int
END AS days_until_expiry`;

const ACTIVE = `q.restored_at IS NULL AND (q.expires_at IS NULL OR q.expires_at > now())`;

// $1 project_id  $2 is_admin(bool)  $3 subject  $4 reason_code|null  $5 limit+1
const LIST_SQL = `
SELECT q.id, q.reason_code, q.criterion, q.op, q.type, q.title,
       left(q.body, 160) AS excerpt, q.quarantined_at, ${DAYS_UNTIL_EXPIRY}
FROM quarantine q
WHERE q.project_id = $1 AND ${ACTIVE}
  AND ($2::boolean OR q.author_identity = $3)
  AND ($4::quarantine_reason_code IS NULL OR q.reason_code = $4::quarantine_reason_code)
ORDER BY q.quarantined_at DESC, q.id DESC
LIMIT $5
`.trim();

// $1 project_id  $2 is_admin  $3 subject  $4 quarantine_id
const DETAIL_SQL = `
SELECT q.id, q.reason_code, q.criterion, q.op, q.type, q.title, q.summary, q.body, q.fields,
       left(q.body, 160) AS excerpt,
       q.judge_reason, q.quarantined_at, q.expires_at, ${DAYS_UNTIL_EXPIRY},
       COALESCE(u.display_name, u.email, q.author_identity) AS author,
       ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       m.id AS rel_id, m.type AS rel_type, m.title AS rel_title, m.summary AS rel_summary,
       m.status AS rel_status, m.current_revision AS rel_version,
       m.origin_branch AS rel_origin_branch, m.origin_pr AS rel_origin_pr, m.updated_at AS rel_updated_at
FROM quarantine q
LEFT JOIN app_user u         ON u.idp_subject = q.author_identity
LEFT JOIN staging_session ss ON ss.id = q.origin_session_id
LEFT JOIN memory m           ON m.id = q.related_memory_id AND m.project_id = q.project_id
WHERE q.project_id = $1 AND q.id = $4 AND ${ACTIVE}
  AND ($2::boolean OR q.author_identity = $3)
`.trim();

// R0 lock + guard. D3: repo gone → no row; non-add without target → not rebuildable.
// SEC-L3 (mirrors isRestorable): redacted content is never restorable.
// $1 quarantine_id  $2 project_id  $3 non-restorable reason codes (text[])  $4 sentinel
const CLAIM_LOCK_SQL = `
SELECT q.id, q.repo_id, q.op, q.type, q.title, q.summary, q.body, q.fields,
       q.target_memory_id, q.target_revision, q.author_identity, ss.pr_number AS origin_pr
FROM quarantine q
JOIN repo r ON r.id = q.repo_id AND r.project_id = q.project_id
LEFT JOIN staging_session ss ON ss.id = q.origin_session_id
WHERE q.id = $1 AND q.project_id = $2 AND ${ACTIVE}
  AND (q.op = 'add' OR q.target_memory_id IS NOT NULL)
  AND (q.reason_code IS NULL OR NOT (q.reason_code::text = ANY($3::text[])))
  AND $4 NOT IN (q.title, q.summary, q.body)
FOR UPDATE OF q
`.trim();

// R1 session. $1 ulid $2 project $3 repo $4 branch $5 opened_by $6 origin_pr
const CLAIM_SESSION_SQL = `
INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, pr_number,
                             last_activity_at, expires_at)
VALUES ($1, $2, $3, $4, 'open', $5, $6, now(), now() + interval '7 days')
`.trim();

// R2 item (pending; ORIGINAL author, D2).
const CLAIM_ITEM_SQL = `
INSERT INTO staging_item (session_id, op, type, title, summary, body, fields, content_hash,
                          target_memory_id, target_revision, judge_state, author_identity)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'pending', $11)
RETURNING id
`.trim();

// R3 label. $1 restored_by $2 item_id $3 quarantine_id
const CLAIM_LABEL_SQL = `
UPDATE quarantine SET restored_by = $1, restored_at = now(), restored_item_id = $2
WHERE id = $3 AND restored_at IS NULL
`.trim();

// Un-claim (one statement). The session is abandoned only while the claimed item
// has no terminal write: not applied (promoted_at), not quarantined ('rejected'),
// not queued ('uncertain' or mandatory_review). 'accepted' is the decision the
// apply path persists before applying, so a rolled-back apply still un-claims.
// The label is cleared only when that abandon happened.
// $1 session_id  $2 project_id  $3 item_id  $4 quarantine_id
const RELEASE_CLAIM_SQL = `
WITH s AS (
  UPDATE staging_session ss SET status = 'abandoned', last_activity_at = now()
  WHERE ss.id = $1 AND ss.project_id = $2 AND ss.status = 'open'
    AND EXISTS (SELECT 1 FROM staging_item si
                 WHERE si.id = $3 AND si.session_id = ss.id
                   AND si.promoted_at IS NULL AND NOT si.mandatory_review
                   AND si.judge_state IN ('pending', 'accepted'))
  RETURNING ss.id
)
UPDATE quarantine q
SET restored_by = NULL, restored_at = NULL, restored_item_id = NULL
WHERE q.id = $4 AND q.project_id = $2 AND q.restored_item_id = $3
  AND EXISTS (SELECT 1 FROM s)
`.trim();

const PURGE_SQL = `
WITH d AS (DELETE FROM quarantine WHERE expires_at < now() RETURNING project_id)
SELECT project_id, count(*)::int AS count FROM d GROUP BY project_id ORDER BY project_id
`.trim();

// ---------------------------------------------------------------------------
// Raw rows
// ---------------------------------------------------------------------------

interface RawListRow {
  id: string;
  reason_code: QuarantineReasonCode | null;
  criterion: QuarantineCriterion | null;
  op: Op;
  type: MemoryType;
  title: string;
  excerpt: string;
  quarantined_at: Date;
  days_until_expiry: number | null;
}

interface RawDetailRow extends RawListRow {
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  judge_reason: string;
  expires_at: Date | null;
  author: string;
  origin_branch: string | null;
  origin_pr: number | null;
  rel_id: string | null;
  rel_type: MemoryType | null;
  rel_title: string | null;
  rel_summary: string | null;
  rel_status: QuarantineRelatedRow['status'] | null;
  rel_version: number | null;
  rel_origin_branch: string | null;
  rel_origin_pr: number | null;
  rel_updated_at: Date | null;
}

interface RawClaimRow {
  id: string;
  repo_id: string;
  op: Op;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  target_memory_id: string | null;
  target_revision: number | null;
  author_identity: string;
  origin_pr: number | null;
}

function toListRow(r: RawListRow): QuarantineListRow {
  return {
    id: r.id,
    reasonCode: r.reason_code,
    criterion: r.criterion,
    op: r.op,
    type: r.type,
    title: r.title,
    excerpt: r.excerpt,
    quarantinedAt: r.quarantined_at,
    daysUntilExpiry: r.days_until_expiry,
  };
}

function isOpenSessionConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'ux_session_open';
}

// ---------------------------------------------------------------------------
// pg implementation
// ---------------------------------------------------------------------------

export class PgQuarantineRepository implements QuarantineRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    projectId: string,
    v: QuarantineViewer,
    q: { reason: QuarantineReasonCode | null; limit: number },
  ): Promise<{ rows: QuarantineListRow[]; truncated: boolean }> {
    const { rows } = await this.pool.query<RawListRow>(LIST_SQL, [
      projectId,
      v.isAdmin,
      v.subject,
      q.reason,
      q.limit + 1,
    ]);
    return { rows: rows.slice(0, q.limit).map(toListRow), truncated: rows.length > q.limit };
  }

  async findVisible(
    projectId: string,
    v: QuarantineViewer,
    id: string,
  ): Promise<QuarantineDetailRow | null> {
    const { rows } = await this.pool.query<RawDetailRow>(DETAIL_SQL, [
      projectId,
      v.isAdmin,
      v.subject,
      id,
    ]);
    const r = rows[0];
    if (!r) return null;
    return {
      ...toListRow(r),
      summary: r.summary,
      body: r.body,
      fields: r.fields ?? {},
      judgeReason: r.judge_reason,
      expiresAt: r.expires_at,
      author: r.author,
      originBranch: r.origin_branch,
      originPr: r.origin_pr,
      related:
        r.rel_id === null
          ? null
          : {
              id: r.rel_id,
              type: r.rel_type!,
              title: r.rel_title!,
              summary: r.rel_summary!,
              status: r.rel_status!,
              version: r.rel_version!,
              originBranch: r.rel_origin_branch,
              originPr: r.rel_origin_pr,
              updatedAt: r.rel_updated_at!,
            },
    };
  }

  async claimForRestore(i: RestoreClaimInput): Promise<RestoreClaim> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<RawClaimRow>(CLAIM_LOCK_SQL, [
        i.quarantineId,
        i.projectId,
        NON_RESTORABLE_REASON_CODES,
        REDACTED_TOKEN,
      ]);
      const q = rows[0];
      if (!q) {
        await client.query('ROLLBACK');
        return { status: 'not_found' };
      }

      const sessionId = ulid();
      const branch = `restore/${q.id}`;
      try {
        await client.query(CLAIM_SESSION_SQL, [
          sessionId,
          i.projectId,
          q.repo_id,
          branch,
          i.openedBy,
          q.origin_pr,
        ]);
      } catch (err) {
        // SEC-L2: an open session already holds `restore/<id>` (ux_session_open)
        // → the same opaque not_found as any other refusal, never a 500.
        if (isOpenSessionConflict(err)) {
          await client.query('ROLLBACK');
          logger.warn('[quarantine] restore session slot already taken', {
            quarantineId: q.id,
          });
          return { status: 'not_found' };
        }
        throw err;
      }

      const fields = q.fields ?? {};
      const contentHash = computeContentHash({
        op: q.op,
        type: q.type,
        title: q.title,
        summary: q.summary,
        body: q.body,
        fields,
        target: q.target_memory_id,
      });
      const item = await client.query<{ id: string }>(CLAIM_ITEM_SQL, [
        sessionId,
        q.op,
        q.type,
        q.title,
        q.summary,
        q.body,
        JSON.stringify(fields),
        contentHash,
        q.target_memory_id,
        q.op === 'add' ? null : q.target_revision,
        q.author_identity,
      ]);
      const itemId = item.rows[0]!.id;

      const label = await client.query(CLAIM_LABEL_SQL, [i.restoredByUserId, itemId, q.id]);
      if ((label.rowCount ?? 0) !== 1) {
        // Unreachable under the row lock; defensive.
        await client.query('ROLLBACK');
        return { status: 'not_found' };
      }

      await client.query('COMMIT');
      return {
        status: 'claimed',
        sessionId,
        itemId,
        repoId: q.repo_id,
        branch,
        originPr: q.origin_pr,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // The original error is rethrown below; record the rollback failure (name only).
        logger.warn('[quarantine] rollback failed after a claim error', {
          errorName: rollbackErr instanceof Error ? rollbackErr.name : 'unknown',
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseRestoreClaim(r: RestoreClaimRelease): Promise<boolean> {
    const res = await this.pool.query(RELEASE_CLAIM_SQL, [
      r.sessionId,
      r.projectId,
      r.itemId,
      r.quarantineId,
    ]);
    return (res.rowCount ?? 0) === 1;
  }

  async purgeExpired(): Promise<Array<{ projectId: string; count: number }>> {
    const { rows } = await this.pool.query<{ project_id: string; count: number }>(PURGE_SQL);
    return rows.map((r) => ({ projectId: r.project_id, count: r.count }));
  }
}
