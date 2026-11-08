/**
 * Test helpers for the memory read path.
 *
 * Provides:
 *  - FakeMemory / FakeRelation — seed types for the in-memory repository fake.
 *  - InMemoryMemoryRepository  — seedable, deterministic fake of MemoryRepository
 *    exposing the two RRF candidate lists (lexical + semantic).
 *
 * Deterministic rank formula (mirrors the SQL decay heuristic, §D4):
 *   rank = (distinct query terms found in title + summary + body)
 *          / (1 + ageDays / 30)
 * where ageDays is derived from row.updated_at vs the injected `now`.
 *
 * The lexical list mirrors the FTS `@@` filter: a record is a lexical candidate
 * only when at least one query term appears in its text.  Tests control rank by
 * choosing updatedAt and query terms, and the semantic list by injecting
 * `embedding` vectors on the seeds.
 */

import type {
  MemoryRepository,
  MemoryRow,
  LexicalCandidateParams,
  RelationRow,
  MemoryDetail,
  ContextRecords,
  RecallCandidateFilters,
} from '../../src/db/memoryRepository.js';
import type { TenantContext } from '../../src/mcp/context.js';
import type { MemoryType } from '../../src/contracts/memory.js';

// ---------------------------------------------------------------------------
// Seed data shapes
// ---------------------------------------------------------------------------

/** Seed record for a memory row. */
export interface FakeMemory {
  id: string;
  projectId: string;
  repoId?: string | null;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields?: Record<string, unknown>;
  /** Defaults to 1 when omitted. */
  currentRevision?: number;
  /** Defaults to 2025-01-01 UTC when omitted. */
  updatedAt?: Date;
  /** Defaults to updatedAt when omitted (used for stale computation). */
  createdAt?: Date;
  /** null means no TTL. */
  ttlDays?: number | null;
  /** Defaults to 'active'. */
  status?: 'active' | 'superseded' | 'deprecated' | 'pending_revalidation';
  originBranch?: string | null;
  originPr?: number | null;
  /**
   * Pre-computed embedding vector for recallSemantic.
   * When undefined/null, the fake treats this row as embedding IS NULL
   * (it will be excluded from recallSemantic results).
   */
  embedding?: number[] | null;
}

/** Seed record for a memory_relation edge. */
export interface FakeRelation {
  fromMemory: string;
  toMemory: string;
  relationType: 'supersedes' | 'conflicts_with' | 'duplicate';
}

// ---------------------------------------------------------------------------
// Rank helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic rank used by InMemoryMemoryRepository.recall.
 *
 * Counts how many distinct query terms (whitespace-split) appear in the
 * concatenated (title + summary + body) text, then applies the same 30-day
 * half-life decay as the production SQL.
 *
 *   rank = termHits / (1 + ageDays / 30)
 *
 * A rank of 0 is returned when no terms match; such records are not lexical
 * candidates (mirrors the FTS `@@` filter).
 */
function computeRank(row: MemoryRow, query: string, now: Date): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const text = `${row.title} ${row.summary} ${row.body}`.toLowerCase();

  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits++;
  }

  const ageDays =
    (now.getTime() - row.updated_at.getTime()) / (1000 * 86400);
  const decay = 1 + ageDays / 30;
  return hits / decay;
}

// ---------------------------------------------------------------------------
// Vector similarity helper (module-private)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1]: higher = more similar.
 * StubEmbedder produces L2-normalized unit vectors, so dot product == cosine similarity,
 * but we compute the full formula for generality.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// InMemoryMemoryRepository
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of MemoryRepository used in unit tests.
 *
 * Seed arrays are provided at construction time.  All three interface methods
 * are deterministic: no randomness, no Date.now() except through the injected
 * `now` factory (default: real clock).
 */
export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly memories: Map<string, FakeMemory>;
  private readonly relations: FakeRelation[];
  private readonly now: () => Date;

  constructor(
    memories: FakeMemory[] = [],
    relations: FakeRelation[] = [],
    now: () => Date = () => new Date(),
  ) {
    this.memories = new Map(memories.map((m) => [m.id, m]));
    this.relations = [...relations];
    this.now = now;
  }

  /** Convert a FakeMemory seed into the MemoryRow projection the mapper expects. */
  private toMemoryRow(m: FakeMemory): MemoryRow {
    return {
      id: m.id,
      repo_id: m.repoId ?? null,
      type: m.type,
      title: m.title,
      summary: m.summary,
      body: m.body,
      fields: m.fields ?? {},
      origin_branch: m.originBranch ?? null,
      origin_pr: m.originPr ?? null,
      current_revision: m.currentRevision ?? 1,
      updated_at: m.updatedAt ?? new Date('2025-01-01T00:00:00Z'),
    };
  }

  // -------------------------------------------------------------------------
  // recallLexicalCandidates
  // -------------------------------------------------------------------------

  async recallLexicalCandidates(
    tenant: TenantContext,
    params: LexicalCandidateParams,
    limit: number,
  ): Promise<MemoryRow[]> {
    const { query, scope, types } = params;
    const now = this.now();

    return Array.from(this.memories.values())
      .filter((m) => {
        if ((m.status ?? 'active') !== 'active') return false;
        if (m.projectId !== tenant.projectId) return false;
        if (scope === 'repo' && m.repoId !== tenant.repoId) return false;
        if (types && types.length > 0 && !types.includes(m.type)) return false;
        return true;
      })
      .map((m) => {
        const row = this.toMemoryRow(m);
        return { row, rank: computeRank(row, query, now) };
      })
      .filter((item) => item.rank > 0)
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        // Tie-break: id DESC (lexicographic descending), as in the SQL.
        if (a.row.id < b.row.id) return 1;
        return a.row.id > b.row.id ? -1 : 0;
      })
      .slice(0, limit)
      .map((item) => item.row);
  }

  // -------------------------------------------------------------------------
  // recallSemantic
  // -------------------------------------------------------------------------

  async recallSemantic(
    tenant: TenantContext,
    queryEmbedding: number[],
    filters: RecallCandidateFilters,
    excludeIds: string[],
    k: number,
  ): Promise<MemoryRow[]> {
    const excludeSet = new Set(excludeIds);

    // Filter: active, same project, scope/types, embedding present, not excluded.
    const candidates = Array.from(this.memories.values()).filter((m) => {
      if ((m.status ?? 'active') !== 'active') return false;
      if (m.projectId !== tenant.projectId) return false;
      if (filters.scope === 'repo' && m.repoId !== tenant.repoId) return false;
      if (
        filters.types &&
        filters.types.length > 0 &&
        !filters.types.includes(m.type)
      ) {
        return false;
      }
      if (!m.embedding || m.embedding.length === 0) return false;
      if (excludeSet.has(m.id)) return false;
      return true;
    });

    // Rank by cosine similarity descending.
    const ranked = candidates
      .map((m) => ({
        row: this.toMemoryRow(m),
        score: cosineSimilarity(queryEmbedding, m.embedding!),
      }))
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, k).map((item) => item.row);
  }

  // -------------------------------------------------------------------------
  // getMemoryByHandle
  // -------------------------------------------------------------------------

  async getMemoryByHandle(
    tenant: TenantContext,
    memoryId: string,
  ): Promise<MemoryDetail | null> {
    const m = this.memories.get(memoryId);

    if (
      !m ||
      (m.status ?? 'active') !== 'active' ||
      m.projectId !== tenant.projectId
    ) {
      return null;
    }

    const memory = this.toMemoryRow(m);

    // Collect relations where one side is this memory and the OTHER side is
    // same-project + active (mirrors the JOIN condition in prod SQL).
    const relations: RelationRow[] = [];
    for (const rel of this.relations) {
      let otherId: string | null = null;
      if (rel.fromMemory === memoryId) {
        otherId = rel.toMemory;
      } else if (rel.toMemory === memoryId) {
        otherId = rel.fromMemory;
      }
      if (!otherId) continue;

      const other = this.memories.get(otherId);
      if (
        !other ||
        (other.status ?? 'active') !== 'active' ||
        other.projectId !== tenant.projectId
      ) {
        continue;
      }

      relations.push({
        relation_type: rel.relationType,
        other_id: otherId,
        other_current_revision: other.currentRevision ?? 1,
      });
    }

    return { memory, relations };
  }

  // -------------------------------------------------------------------------
  // getContextRecords
  // -------------------------------------------------------------------------

  async getContextRecords(
    tenant: TenantContext,
    phase2Limit: number,
  ): Promise<ContextRecords> {
    const now = this.now();

    const active = Array.from(this.memories.values()).filter(
      (m) =>
        (m.status ?? 'active') === 'active' &&
        m.projectId === tenant.projectId,
    );

    /** Compute stale: ttlDays is set AND now is past createdAt + ttlDays. */
    const computeStale = (m: FakeMemory): boolean => {
      if (!m.ttlDays) return false;
      const createdAt =
        m.createdAt ?? m.updatedAt ?? new Date('2025-01-01T00:00:00Z');
      const expiresAt = new Date(
        createdAt.getTime() + m.ttlDays * 86400 * 1000,
      );
      return now > expiresAt;
    };

    // Phase 1: constraint + domain_rule; order by type ASC then updatedAt DESC.
    const phase1 = active
      .filter((m) => m.type === 'constraint' || m.type === 'domain_rule')
      .sort((a, b) => {
        if (a.type !== b.type) return a.type < b.type ? -1 : 1; // ASC
        const aTime = (a.updatedAt ?? new Date(0)).getTime();
        const bTime = (b.updatedAt ?? new Date(0)).getTime();
        return bTime - aTime; // updatedAt DESC
      })
      .map((m): MemoryRow => {
        const row = this.toMemoryRow(m);
        row.stale = computeStale(m);
        return row;
      });

    // Phase 2: decision + gotcha; order by updatedAt DESC, capped at phase2Limit.
    const phase2 = active
      .filter((m) => m.type === 'decision' || m.type === 'gotcha')
      .sort((a, b) => {
        const aTime = (a.updatedAt ?? new Date(0)).getTime();
        const bTime = (b.updatedAt ?? new Date(0)).getTime();
        return bTime - aTime; // updatedAt DESC
      })
      .slice(0, phase2Limit)
      .map((m): MemoryRow => {
        const row = this.toMemoryRow(m);
        row.stale = computeStale(m);
        return row;
      });

    return { phase1, phase2 };
  }
}
