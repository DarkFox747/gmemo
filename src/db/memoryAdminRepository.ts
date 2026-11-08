/**
 * MemoryAdminRepository — the project_admin read model for browsing memory (C5, HU-13).
 *
 * List (replaces C4's pending-only list), detail and revision history, plus the
 * repo lookup used by direct writes. Every statement carries project_id = $1;
 * memory_revision has no project column, so it is scoped through JOIN memory.
 * Parameterized $N only. The read path for agents (MemoryRepository, active
 * only) is untouched.
 *
 * Cursor: base64url("<updated_key>|<uuid>"), where updated_key is produced by
 * SQL with microseconds so the (updated_at, id) keyset is exact (a JS Date would
 * truncate to milliseconds and skip rows). A well-formed but impossible date is
 * rejected before SQL (SEC-L1: 400, never a Postgres 22008 → 500).
 *
 * People (SEC-L3): author and approver are resolved to app_user.display_name
 * only — never the email, the raw idp subject or (in the DTO) the app_user id.
 */

import type pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import { AppError, ErrorCode } from '../errors/appError.js';

export type MemoryStatus = 'active' | 'superseded' | 'deprecated' | 'pending_revalidation';

export interface MemoryListFilter {
  status: MemoryStatus;
  type: MemoryType | null;
  /** Trimmed, non-empty; a websearch_to_tsquery filter (not a ranking). */
  q: string | null;
  cursor: string | null;
  limit: number;
}

export interface MemoryListRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  current_revision: number;
  provenance: string;
  origin_branch: string | null;
  origin_pr: number | null;
  revalidate_at: Date | null;
  updated_at: Date;
}

export interface MemoryDetailRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  status: MemoryStatus;
  current_revision: number;
  provenance: string;
  /** Author display name only (SEC-L3: never the email or the raw idp subject); null when unset. */
  author: string | null;
  /** app_user.id — internal (the "is approved" signal); never exposed by the DTO. */
  approved_by: string | null;
  /** Approver display name only; null when unset. */
  approver: string | null;
  repo_id: string | null;
  repo_slug: string | null;
  origin_branch: string | null;
  origin_pr: number | null;
  created_at: Date;
  updated_at: Date;
  revalidate_at: Date | null;
  retired_reason: string | null;
}

export interface MemoryRevisionRow {
  revision_no: number;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  /** Display name only (SEC-L3); null when unset. */
  author: string | null;
  created_at: Date;
}

export interface MemoryAdminRepository {
  listMemories(
    projectId: string,
    f: MemoryListFilter,
  ): Promise<{ rows: MemoryListRow[]; nextCursor: string | null }>;
  /** Any status; null when absent or foreign. */
  findMemory(projectId: string, memoryId: string): Promise<MemoryDetailRow | null>;
  /** Newest first, at most REVISIONS_LIMIT rows. */
  listRevisions(
    projectId: string,
    memoryId: string,
  ): Promise<{ rows: MemoryRevisionRow[]; truncated: boolean }>;
  /** The given repo when it belongs to the project, else the project's first repo; null = none. */
  findProjectRepoId(projectId: string, repoId: string | null): Promise<string | null>;
}

export const REVISIONS_LIMIT = 100;

// ---------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------

const UPDATED_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeMemoryListCursor(c: { updatedKey: string; id: string }): string {
  return Buffer.from(`${c.updatedKey}|${c.id}`, 'utf8').toString('base64url');
}

/**
 * SEC-L1: the regex only checks the shape; this checks the instant exists
 * (no month 13, Feb 30, hour 24 or year 0000 — Postgres rejects all of them).
 * The millisecond prefix must round-trip through Date unchanged.
 */
function isRealInstant(updatedKey: string): boolean {
  const ms = updatedKey.slice(0, 23); // YYYY-MM-DDTHH:MM:SS.mmm
  if (ms.startsWith('0000')) return false;
  const t = Date.parse(`${ms}Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 23) === ms;
}

/** Malformed → AppError(INVALID_REQUEST) (400; INVALID_REFERENCE would be a REST 404). */
export function decodeMemoryListCursor(s: string): { updatedKey: string; id: string } {
  const raw = Buffer.from(s, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep < 0) throw new AppError(ErrorCode.INVALID_REQUEST);
  const updatedKey = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!UPDATED_KEY_RE.test(updatedKey) || !isRealInstant(updatedKey) || !UUID_RE.test(id)) {
    throw new AppError(ErrorCode.INVALID_REQUEST);
  }
  return { updatedKey, id };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// $1 project_id $2 status $3 type|null $4 q|null $5 cursor_ts|null $6 cursor_id|null $7 limit+1
const LIST_SQL = `
SELECT m.id, m.type, m.title, m.summary, m.status, m.current_revision, m.provenance,
       m.origin_branch, m.origin_pr, m.revalidate_at, m.updated_at,
       to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_key
FROM memory m
WHERE m.project_id = $1
  AND m.status = $2::memory_status
  AND ($3::memory_type IS NULL OR m.type = $3::memory_type)
  AND ($4::text IS NULL OR m.content_tsv @@ websearch_to_tsquery('english', $4::text))
  AND ($5::timestamptz IS NULL OR (m.updated_at, m.id) < ($5::timestamptz, $6::uuid))
ORDER BY m.updated_at DESC, m.id DESC
LIMIT $7
`.trim();

// $1 project_id $2 memory_id (any status)
const DETAIL_SQL = `
SELECT m.id, m.type, m.title, m.summary, m.body, m.fields, m.status, m.current_revision,
       m.provenance, au.display_name AS author,
       m.approved_by, ap.display_name AS approver,
       m.repo_id, r.slug AS repo_slug, m.origin_branch, m.origin_pr,
       m.created_at, m.updated_at, m.revalidate_at, m.retired_reason
FROM memory m
LEFT JOIN app_user au ON au.idp_subject = m.author_identity
LEFT JOIN app_user ap ON ap.id = m.approved_by
LEFT JOIN repo r      ON r.id = m.repo_id AND r.project_id = m.project_id
WHERE m.project_id = $1 AND m.id = $2
`.trim();

// $1 project_id $2 memory_id $3 limit+1
const REVISIONS_SQL = `
SELECT mr.revision_no, mr.op, mr.type, mr.title, mr.summary, mr.body, mr.fields,
       u.display_name AS author, mr.created_at
FROM memory_revision mr
JOIN memory m ON m.id = mr.memory_id AND m.project_id = $1
LEFT JOIN app_user u ON u.idp_subject = mr.author_identity
WHERE mr.memory_id = $2
ORDER BY mr.revision_no DESC
LIMIT $3
`.trim();

// $1 project_id $2 repo_id|null
const PROJECT_REPO_SQL = `
SELECT id FROM repo WHERE project_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
ORDER BY created_at ASC, id ASC LIMIT 1
`.trim();

interface RawListRow extends MemoryListRow {
  updated_key: string;
}

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgMemoryAdminRepository implements MemoryAdminRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listMemories(
    projectId: string,
    f: MemoryListFilter,
  ): Promise<{ rows: MemoryListRow[]; nextCursor: string | null }> {
    const cursor = f.cursor === null ? null : decodeMemoryListCursor(f.cursor);
    const { rows } = await this.pool.query<RawListRow>(LIST_SQL, [
      projectId,
      f.status,
      f.type,
      f.q,
      cursor?.updatedKey ?? null,
      cursor?.id ?? null,
      f.limit + 1,
    ]);
    const kept = rows.length > f.limit ? rows.slice(0, f.limit) : rows;
    const last = kept[kept.length - 1];
    const nextCursor =
      rows.length > f.limit && last
        ? encodeMemoryListCursor({ updatedKey: last.updated_key, id: last.id })
        : null;
    return { rows: kept.map(({ updated_key: _key, ...r }) => r), nextCursor };
  }

  async findMemory(projectId: string, memoryId: string): Promise<MemoryDetailRow | null> {
    const { rows } = await this.pool.query<MemoryDetailRow>(DETAIL_SQL, [projectId, memoryId]);
    return rows[0] ?? null;
  }

  async listRevisions(
    projectId: string,
    memoryId: string,
  ): Promise<{ rows: MemoryRevisionRow[]; truncated: boolean }> {
    const { rows } = await this.pool.query<MemoryRevisionRow>(REVISIONS_SQL, [
      projectId,
      memoryId,
      REVISIONS_LIMIT + 1,
    ]);
    const truncated = rows.length > REVISIONS_LIMIT;
    return { rows: truncated ? rows.slice(0, REVISIONS_LIMIT) : rows, truncated };
  }

  async findProjectRepoId(projectId: string, repoId: string | null): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(PROJECT_REPO_SQL, [projectId, repoId]);
    return rows[0]?.id ?? null;
  }
}
