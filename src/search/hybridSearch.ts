/**
 * Hybrid ranking of active memories (HU-08.1, HU-08.3) — the ONE search code path
 * shared by MCP `recall` and the web search explorer (GET /api/v1/projects/:p/search).
 *
 *   - lexical top-50 (BM25 with time-decay) and semantic top-50 (pgvector cosine),
 *     both filtered by project, status='active', types and scope;
 *   - fused with score = Σ 1/(60 + rank), ties broken by memory id (rrf.ts), each
 *     candidate carrying its lexical/semantic rank (provenance);
 *   - with scope=project and a repo, that repo's memories come first (stable).
 *
 * Fail-soft: if embedding or the semantic query fails, the lexical list alone is
 * used, `semantic` is 'unavailable' and one warning is logged (error name only —
 * never the query text). An empty semantic list that did not throw is 'ok'.
 *
 * Callers own limits, pagination and response shapes; neither may re-implement
 * fusion. A repo-scoped search without a repo is a programming error (throws)
 * and never widens to the project.
 */

import type { MemoryType } from '../contracts/memory.js';
import type { MemoryRepository, MemoryRow, SearchTenant } from '../db/memoryRepository.js';
import type { Embedder } from '../embedder/embedder.js';
import { logger } from '../observability/logger.js';
import { fuseRrf, prioritizeRepo, RRF_CANDIDATES, type FusedCandidate } from './rrf.js';

export interface HybridSearchDeps {
  memoryRepository: Pick<MemoryRepository, 'recallLexicalCandidates' | 'recallSemantic'>;
  embedder: Embedder;
}

export interface HybridSearchParams {
  query: string;
  scope: 'repo' | 'project';
  /** undefined = all types (callers normalize [] → undefined). */
  types?: MemoryType[];
}

export interface HybridSearchResult {
  /** Fused, repo-prioritized when applicable. */
  ranked: FusedCandidate<MemoryRow>[];
  /** 'unavailable' only when embed() or recallSemantic threw. */
  semantic: 'ok' | 'unavailable';
}

export async function rankActiveMemories(
  deps: HybridSearchDeps,
  tenant: SearchTenant,
  params: HybridSearchParams,
): Promise<HybridSearchResult> {
  const { query, scope, types } = params;
  if (scope === 'repo' && tenant.repoId === null) {
    throw new Error('rankActiveMemories: repo scope requires a repo');
  }

  const [lexical, semantic] = await Promise.all([
    deps.memoryRepository.recallLexicalCandidates(tenant, { query, scope, types }, RRF_CANDIDATES),
    semanticFailSoft(deps, tenant, params),
  ]);

  const fused = fuseRrf(lexical, semantic.rows);
  const ranked =
    scope === 'project' && tenant.repoId !== null ? prioritizeRepo(fused, tenant.repoId) : fused;

  return { ranked, semantic: semantic.ok ? 'ok' : 'unavailable' };
}

/** Semantic candidate list; any failure degrades to an empty list plus a warning. */
async function semanticFailSoft(
  deps: HybridSearchDeps,
  tenant: SearchTenant,
  { query, scope, types }: HybridSearchParams,
): Promise<{ rows: MemoryRow[]; ok: boolean }> {
  try {
    const queryEmbedding = await deps.embedder.embed(query);
    const rows = await deps.memoryRepository.recallSemantic(
      tenant,
      queryEmbedding,
      { scope, types },
      [],
      RRF_CANDIDATES,
    );
    return { rows, ok: true };
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    logger.warn(`[search] semantic side failed (${errorName}) — returning lexical-only`);
    return { rows: [], ok: false };
  }
}
