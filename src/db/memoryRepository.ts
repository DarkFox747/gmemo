/**
 * MemoryRepository — the single DB seam for the memory read path.
 *
 * The interface exposes exactly the three queries the three read tools need:
 *   1. recall              — FTS + time-decay, keyset-paginated (D4/D5)
 *   2. getMemoryByHandle   — single active memory + bidirectional relations (D9)
 *   3. getContextRecords   — phase1 (constraint/domain_rule) + phase2 (decision/gotcha) (D6)
 *
 * All SQL uses parameterized queries exclusively — no string concatenation of
 * query text, types, scope, repoId, cursor, or handle values.
 *
 * The cursor codec is private to this module but re-exported so the in-memory
 * fake (tests/memory/fakes.ts) can exercise identical pagination logic.
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { TenantContext } from '../mcp/context.js';
import { AppError, ErrorCode } from '../errors/appError.js';
import { toVectorParam } from './vector.js';

// ---------------------------------------------------------------------------
// Supporting types (exported for use by mapper + fake)
// ---------------------------------------------------------------------------

/** Internal projection of a memory row used to build MemoryRecord. */
export interface MemoryRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  origin_branch: string | null;
  origin_pr: number | null;
  current_revision: number;
  updated_at: Date;
  /** Only populated by getContextRecords; TTL-expired-but-active. */
  stale?: boolean;
}

export interface RecallParams {
  query: string;
  scope: 'repo' | 'project';
  types?: MemoryType[];
  /** Caller-normalized (default 8, max 50). */
  limit: number;
  /** Opaque cursor from a prior recall response; decoded inside the repo. */
  cursor?: string | null;
}

export interface RecallResult {
  rows: MemoryRow[];
  totalMatches: number;
  nextCursor: string | null;
}

export interface RelationRow {
  relation_type: 'supersedes' | 'conflicts_with' | 'duplicate';
  other_id: string;
  other_current_revision: number;
}

export interface MemoryDetail {
  memory: MemoryRow;
  relations: RelationRow[];
}

export interface ContextRecords {
  /** constraint + domain_rule — never budget-dropped by the handler. */
  phase1: MemoryRow[];
  /** decision + gotcha — recency-ordered candidates; handler trims by token budget. */
  phase2: MemoryRow[];
}

/**
 * Filters for the vector nearest-neighbour fallback query.
 * scope → repo_id derivation mirrors recall (same rule, same layer).
 */
export interface RecallSemanticFilters {
  scope: 'repo' | 'project';
  types?: MemoryType[];
}

// ---------------------------------------------------------------------------
// Cursor codec (private to this module; re-exported for the fake)
// ---------------------------------------------------------------------------

export interface RecallCursor {
  rank: number;
  id: string;
}

/** Encodes a recall cursor as base64url("${rank}:${id}"). */
export function encodeRecallCursor(c: RecallCursor): string {
  return Buffer.from(`${c.rank}:${c.id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a recall cursor. Throws AppError(INVALID_REFERENCE) on any
 * malformed input — same opaque error class as an invalid handle (D5).
 */
export function decodeRecallCursor(s: string): RecallCursor {
  if (typeof s !== 'string' || s.length === 0) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }
  // Node never throws on Buffer.from(…, 'base64url'); the post-decode UUID regex
  // and Number.isFinite check below are the sole guards against malformed input.
  const raw = Buffer.from(s, 'base64url').toString('utf8');

  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) throw new AppError(ErrorCode.INVALID_REFERENCE);

  const rankStr = raw.slice(0, colonIdx);
  const id = raw.slice(colonIdx + 1);

  // Number() rejects partial parses like "1.5abc" (parseFloat would accept them).
  const rank = Number(rankStr);
  if (!Number.isFinite(rank)) throw new AppError(ErrorCode.INVALID_REFERENCE);

  // UUID: 8-4-4-4-12 hex chars with hyphens; no further ':' expected.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) throw new AppError(ErrorCode.INVALID_REFERENCE);

  return { rank, id };
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  /**
   * FTS + time-decay recall, project-scoped (repo-scoped when scope='repo'),
   * status='active', optional type filter, keyset paginated over (rank, id).
   * Returns the page rows, total_matches (full predicate, no keyset), and the
   * next opaque cursor (null when exhausted). Throws AppError on malformed cursor.
   */
  recall(tenant: TenantContext, params: RecallParams): Promise<RecallResult>;

  /**
   * Pure vector nearest-neighbour scan — Phase 2 of the hybrid recall.
   * Returns at most k rows ordered by cosine distance to queryEmbedding,
   * filtered to active+project-scoped rows that have a non-null embedding and
   * whose ids are not in excludeIds (Phase-1 dedup).
   * Never called with a null queryEmbedding — the handler only invokes it on a
   * successful embed. No cursor, no COUNT (these rows are first-page-only extras).
   */
  recallSemantic(
    tenant: TenantContext,
    queryEmbedding: number[],
    filters: RecallSemanticFilters,
    excludeIds: string[],
    k: number,
  ): Promise<MemoryRow[]>;

  /**
   * Fetch one active memory in the caller's project by id, plus its typed
   * relations (both directions; each other side project-scoped + active).
   * Returns null when the memory is absent / non-active / cross-project
   * (the handler maps null → opaque reference error). Does NOT read
   * memory_revision — the v1 contract exposes no revision history.
   */
  getMemoryByHandle(tenant: TenantContext, memoryId: string): Promise<MemoryDetail | null>;

  /**
   * get_context source data: phase1 (constraint/domain_rule) whole; phase2
   * (decision/gotcha) recency-ordered candidates. `stale` computed in SQL.
   * The handler applies the token budget between whole records (phase1 kept).
   */
  getContextRecords(tenant: TenantContext, phase2Limit: number): Promise<ContextRecords>;
}

// ---------------------------------------------------------------------------
// Internal raw row types (pg-typed; private to this module)
// ---------------------------------------------------------------------------

interface RawPageRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  origin_branch: string | null;
  origin_pr: number | null;
  current_revision: number;
  updated_at: Date;
  rank: number;
}

interface RawMemoryRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  origin_branch: string | null;
  origin_pr: number | null;
  current_revision: number;
  updated_at: Date;
}

interface RawRelationRow {
  relation_type: string;
  other_id: string;
  other_current_revision: number;
}

interface RawContextRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  origin_branch: string | null;
  origin_pr: number | null;
  current_revision: number;
  updated_at: Date;
  stale: boolean;
}

interface CountRow {
  total: number;
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

// D4/D5: CTE so the computed `rank` alias is referenceable in the keyset WHERE.
const RECALL_PAGE_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
ranked AS (
  SELECT m.id, m.type, m.title, m.summary, m.body, m.fields,
         m.origin_branch, m.origin_pr, m.current_revision, m.updated_at,
         ts_rank_cd(m.content_tsv, q.tsq)
           / (1 + (EXTRACT(EPOCH FROM (now() - m.updated_at)) / 86400.0) / 30.0) AS rank
  FROM memory m, q
  WHERE m.project_id = $2
    AND m.status = 'active'
    AND m.content_tsv @@ q.tsq
    AND ($3::uuid IS NULL OR m.repo_id = $3)
    AND ($4::text[] IS NULL OR m.type = ANY($4::memory_type[]))
)
SELECT * FROM ranked
WHERE ($5::float8 IS NULL OR rank < $5 OR (rank = $5 AND id < $6::uuid))
ORDER BY rank DESC, id DESC
LIMIT $7
`.trim();

// Separate count over the same predicate (no keyset, no limit) — D5.
const RECALL_COUNT_SQL = `
SELECT COUNT(*)::int AS total
FROM memory m, websearch_to_tsquery('english', $1) q
WHERE m.project_id = $2
  AND m.status = 'active'
  AND m.content_tsv @@ q
  AND ($3::uuid IS NULL OR m.repo_id = $3)
  AND ($4::text[] IS NULL OR m.type = ANY($4::memory_type[]))
`.trim();

// Phase-2 pure vector nearest-neighbour scan (HNSW index accelerates this).
// $1=project_id  $2=repo_id|null  $3=types|null  $4=exclude_ids  $5=query_vec  $6=k
const RECALL_SEMANTIC_SQL = `
SELECT m.id, m.type, m.title, m.summary, m.body, m.fields,
       m.origin_branch, m.origin_pr, m.current_revision, m.updated_at
FROM memory m
WHERE m.project_id = $1
  AND m.status = 'active'
  AND m.embedding IS NOT NULL
  AND ($2::uuid IS NULL OR m.repo_id = $2)
  AND ($3::text[] IS NULL OR m.type = ANY($3::memory_type[]))
  AND m.id <> ALL($4::uuid[])
ORDER BY m.embedding <=> $5::vector
LIMIT $6
`.trim();

const GET_MEMORY_SQL = `
SELECT id, type, title, summary, body, fields,
       origin_branch, origin_pr, current_revision, updated_at
FROM memory
WHERE id = $1 AND project_id = $2 AND status = 'active'
`.trim();

// Both directions; other side must be same-project + active (prevents cross-tenant leaks).
const GET_RELATIONS_SQL = `
SELECT r.relation_type,
       (CASE WHEN r.from_memory = $1 THEN r.to_memory ELSE r.from_memory END) AS other_id,
       om.current_revision AS other_current_revision
FROM memory_relation r
JOIN memory om
  ON om.id = (CASE WHEN r.from_memory = $1 THEN r.to_memory ELSE r.from_memory END)
 AND om.project_id = $2
 AND om.status = 'active'
WHERE r.from_memory = $1 OR r.to_memory = $1
ORDER BY r.created_at ASC
`.trim();

// D6: phase1 — constraints + domain_rules, always returned whole (never budget-dropped).
const CONTEXT_PHASE1_SQL = `
SELECT id, type, title, summary, body, fields, origin_branch, origin_pr,
       current_revision, updated_at,
       (ttl_days IS NOT NULL AND now() > created_at + make_interval(days => ttl_days)) AS stale
FROM memory
WHERE project_id = $1
  AND status = 'active'
  AND type IN ('constraint','domain_rule')
ORDER BY type ASC, updated_at DESC
`.trim();

// D6: phase2 — decision + gotcha, recency-ordered candidate set; handler applies budget.
const CONTEXT_PHASE2_SQL = `
SELECT id, type, title, summary, body, fields, origin_branch, origin_pr,
       current_revision, updated_at,
       (ttl_days IS NOT NULL AND now() > created_at + make_interval(days => ttl_days)) AS stale
FROM memory
WHERE project_id = $1
  AND status = 'active'
  AND type IN ('decision','gotcha')
ORDER BY updated_at DESC
LIMIT $2
`.trim();

// ---------------------------------------------------------------------------
// Shared row mapper (module-private)
// ---------------------------------------------------------------------------

/**
 * Maps a raw DB row (without `rank`) to a MemoryRow.
 * Used by both recall (RawPageRow has an extra `rank` that is ignored here)
 * and recallSemantic (RawMemoryRow, no `rank`).
 */
function mapRow(r: RawMemoryRow): MemoryRow {
  return {
    id: r.id,
    type: r.type as MemoryType,
    title: r.title,
    summary: r.summary,
    body: r.body,
    fields: r.fields,
    origin_branch: r.origin_branch,
    origin_pr: r.origin_pr,
    current_revision: r.current_revision,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async recall(tenant: TenantContext, params: RecallParams): Promise<RecallResult> {
    const { query, scope, types, limit, cursor } = params;
    const { projectId, repoId } = tenant;

    // Decode cursor; throws AppError(INVALID_REFERENCE) on malformed.
    let decodedCursor: RecallCursor | null = null;
    if (cursor) {
      decodedCursor = decodeRecallCursor(cursor);
    }

    const repoIdParam: string | null = scope === 'repo' ? repoId : null;
    const typesParam: MemoryType[] | null = types ?? null;

    const pageParams = [
      query,                              // $1
      projectId,                          // $2
      repoIdParam,                        // $3 — null → project scope
      typesParam,                         // $4 — null → all types
      decodedCursor?.rank ?? null,        // $5 — null → first page
      decodedCursor?.id ?? null,          // $6 — null → first page
      limit + 1,                          // $7 — extra row detects next page
    ];

    const countParams = [
      query,       // $1
      projectId,   // $2
      repoIdParam, // $3
      typesParam,  // $4
    ];

    const [pageResult, countResult] = await Promise.all([
      this.pool.query<RawPageRow>(RECALL_PAGE_SQL, pageParams),
      this.pool.query<CountRow>(RECALL_COUNT_SQL, countParams),
    ]);

    const hasNextPage = pageResult.rows.length === limit + 1;
    const resultRows = hasNextPage ? pageResult.rows.slice(0, limit) : pageResult.rows;

    let nextCursor: string | null = null;
    if (hasNextPage && resultRows.length > 0) {
      const last = resultRows[resultRows.length - 1];
      nextCursor = encodeRecallCursor({ rank: last.rank, id: last.id });
    }

    const rows: MemoryRow[] = resultRows.map((r) => mapRow(r));

    const totalMatches = countResult.rows[0]?.total ?? 0;

    return { rows, totalMatches, nextCursor };
  }

  async recallSemantic(
    tenant: TenantContext,
    queryEmbedding: number[],
    filters: RecallSemanticFilters,
    excludeIds: string[],
    k: number,
  ): Promise<MemoryRow[]> {
    const { projectId, repoId } = tenant;
    const repoIdParam: string | null = filters.scope === 'repo' ? repoId : null;
    const typesParam: MemoryType[] | null =
      filters.types && filters.types.length > 0 ? filters.types : null;

    const params = [
      projectId,                    // $1
      repoIdParam,                  // $2 — null → project scope
      typesParam,                   // $3 — null → all types
      excludeIds,                   // $4 — uuid[]; [] → id <> ALL('{}') is TRUE
      toVectorParam(queryEmbedding),// $5 — vector literal (never null on this path)
      k,                            // $6
    ];

    const { rows } = await this.pool.query<RawMemoryRow>(RECALL_SEMANTIC_SQL, params);
    return rows.map((r) => mapRow(r));
  }

  async getMemoryByHandle(
    tenant: TenantContext,
    memoryId: string,
  ): Promise<MemoryDetail | null> {
    const { projectId } = tenant;

    const memResult = await this.pool.query<RawMemoryRow>(GET_MEMORY_SQL, [
      memoryId,
      projectId,
    ]);

    if (memResult.rows.length === 0) return null;

    const r = memResult.rows[0];
    const memory: MemoryRow = {
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      summary: r.summary,
      body: r.body,
      fields: r.fields,
      origin_branch: r.origin_branch,
      origin_pr: r.origin_pr,
      current_revision: r.current_revision,
      updated_at: r.updated_at,
    };

    const relResult = await this.pool.query<RawRelationRow>(GET_RELATIONS_SQL, [
      memoryId,
      projectId,
    ]);

    const relations: RelationRow[] = relResult.rows.map((rel) => ({
      relation_type: rel.relation_type as RelationRow['relation_type'],
      other_id: rel.other_id,
      other_current_revision: rel.other_current_revision,
    }));

    return { memory, relations };
  }

  async getContextRecords(
    tenant: TenantContext,
    phase2Limit: number,
  ): Promise<ContextRecords> {
    const { projectId } = tenant;

    const [phase1Result, phase2Result] = await Promise.all([
      this.pool.query<RawContextRow>(CONTEXT_PHASE1_SQL, [projectId]),
      this.pool.query<RawContextRow>(CONTEXT_PHASE2_SQL, [projectId, phase2Limit]),
    ]);

    const toRow = (r: RawContextRow): MemoryRow => ({
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      summary: r.summary,
      body: r.body,
      fields: r.fields,
      origin_branch: r.origin_branch,
      origin_pr: r.origin_pr,
      current_revision: r.current_revision,
      updated_at: r.updated_at,
      stale: r.stale,
    });

    return {
      phase1: phase1Result.rows.map(toRow),
      phase2: phase2Result.rows.map(toRow),
    };
  }
}
