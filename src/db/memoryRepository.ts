/**
 * MemoryRepository — the single DB seam for the memory read path.
 *
 * The interface exposes the queries the three read tools need:
 *   1. recallLexicalCandidates / recallSemantic — the two ordered candidate lists
 *      (BM25 + time-decay, pgvector cosine) that the recall handler fuses with RRF
 *   2. getMemoryByHandle   — single active memory + bidirectional relations (D9)
 *   3. getContextRecords   — phase1 (constraint/domain_rule) + phase2 (decision/gotcha) (D6)
 *
 * All SQL uses parameterized queries exclusively — no string concatenation of
 * query text, types, scope, repoId, or handle values.
 */

import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { TenantContext } from '../mcp/context.js';
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
  /** Owning repo; populated by the recall candidate queries (repo-priority in the handler). */
  repo_id?: string | null;
  /** Only populated by getContextRecords; TTL-expired-but-active. */
  stale?: boolean;
}

/**
 * Tenant of a candidate query. MCP recall passes its TenantContext; the web
 * search explorer is project-level and passes repoId null (no repo, no branch).
 * repoId reaches SQL only when scope === 'repo'.
 */
export interface SearchTenant {
  projectId: string;
  repoId: string | null;
}

/** Filters shared by both candidate queries (scope → repo_id derivation lives in the repo). */
export interface RecallCandidateFilters {
  scope: 'repo' | 'project';
  types?: MemoryType[];
}

/** Lexical candidate query: the shared filters plus the raw query text. */
export interface LexicalCandidateParams extends RecallCandidateFilters {
  query: string;
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

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MemoryRepository {
  /**
   * Lexical candidate list: FTS (`websearch_to_tsquery('english')`) ranked by
   * `ts_rank_cd / (1 + age_days/30)`, project-scoped (repo-scoped when
   * scope='repo'), status='active', optional type filter. Ordered by
   * (rank DESC, id DESC), at most `limit` rows. No keyset, no COUNT — the
   * handler fuses this list with the semantic one and paginates by offset.
   */
  recallLexicalCandidates(
    tenant: SearchTenant,
    params: LexicalCandidateParams,
    limit: number,
  ): Promise<MemoryRow[]>;

  /**
   * Semantic candidate list: pgvector cosine nearest neighbours of
   * queryEmbedding, same filters as the lexical list, status='active',
   * `embedding IS NOT NULL`, ordered by distance, at most k rows. Rows whose id
   * is in excludeIds are skipped (the recall handler always passes []).
   * Never called with a null embedding — the handler only invokes it after a
   * successful embed.
   */
  recallSemantic(
    tenant: SearchTenant,
    queryEmbedding: number[],
    filters: RecallCandidateFilters,
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

interface RawMemoryRow {
  id: string;
  repo_id?: string | null;
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

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

// Lexical candidates: BM25 (ts_rank_cd) with 30-day time-decay, fully ordered, no keyset/COUNT.
// $1=query  $2=project_id  $3=repo_id|null  $4=types|null  $5=limit
const RECALL_LEXICAL_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
SELECT m.id, m.repo_id, m.type, m.title, m.summary, m.body, m.fields,
       m.origin_branch, m.origin_pr, m.current_revision, m.updated_at,
       ts_rank_cd(m.content_tsv, q.tsq)
         / (1 + (EXTRACT(EPOCH FROM (now() - m.updated_at)) / 86400.0) / 30.0) AS rank
FROM memory m, q
WHERE m.project_id = $2
  AND m.status = 'active'
  AND m.content_tsv @@ q.tsq
  AND ($3::uuid IS NULL OR m.repo_id = $3)
  AND ($4::text[] IS NULL OR m.type = ANY($4::memory_type[]))
ORDER BY rank DESC, m.id DESC
LIMIT $5
`.trim();

// Semantic candidates: pure vector nearest-neighbour scan (HNSW index accelerates this).
// $1=project_id  $2=repo_id|null  $3=types|null  $4=exclude_ids  $5=query_vec  $6=k
const RECALL_SEMANTIC_SQL = `
SELECT m.id, m.repo_id, m.type, m.title, m.summary, m.body, m.fields,
       m.origin_branch, m.origin_pr, m.current_revision, m.updated_at
FROM memory m
WHERE m.project_id = $1
  AND m.status = 'active'
  AND m.embedding IS NOT NULL
  AND ($2::uuid IS NULL OR m.repo_id = $2)
  AND ($3::text[] IS NULL OR m.type = ANY($3::memory_type[]))
  AND m.id <> ALL($4::uuid[])
ORDER BY m.embedding <=> $5::vector, m.id
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
 * Maps a raw candidate row to a MemoryRow. The lexical query also selects a
 * `rank` column; it is only used for ordering in SQL and is ignored here.
 */
function mapRow(r: RawMemoryRow): MemoryRow {
  return {
    id: r.id,
    repo_id: r.repo_id ?? null,
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

  async recallLexicalCandidates(
    tenant: SearchTenant,
    params: LexicalCandidateParams,
    limit: number,
  ): Promise<MemoryRow[]> {
    const { query, scope, types } = params;
    const { projectId, repoId } = tenant;

    const { rows } = await this.pool.query<RawMemoryRow>(RECALL_LEXICAL_SQL, [
      query,                                          // $1
      projectId,                                      // $2
      scope === 'repo' ? repoId : null,               // $3 — null → project scope
      types && types.length > 0 ? types : null,       // $4 — null → all types
      limit,                                          // $5
    ]);
    return rows.map((r) => mapRow(r));
  }

  async recallSemantic(
    tenant: SearchTenant,
    queryEmbedding: number[],
    filters: RecallCandidateFilters,
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
