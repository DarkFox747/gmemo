/**
 * recall tool handler — contract §2 / §8.
 *
 * Hybrid recall by Reciprocal Rank Fusion (HU-08.1):
 *   - lexical top-50 (BM25 with time-decay) and semantic top-50 (pgvector cosine),
 *     both filtered by project, status='active', types and scope;
 *   - fused with score = Σ 1/(60 + rank), ties broken by memory id (src/search/rrf.ts);
 *   - with scope=project the query's repo comes first (HU-08.3), then the rest.
 *
 * Fail-soft: if embedding or the semantic query fails, the lexical list alone is
 * used and a warning is logged (error name only — never the query text).
 *
 * Pagination: opaque offset cursor over the fused list (a fused, query-time score
 * has no stable keyset). Response shape stays {results, total_matches, cursor};
 * total_matches = number of fused candidates.
 *
 * Repo priority is applied AFTER taking the top 50 of each ranking: a query-repo
 * memory below rank 50 in both lists is not returned. Offset pages are recomputed
 * on every request, so concurrent writes can shift results between pages.
 *
 * Staged drafts (HU-08.4): first page only, prepended, at most `limit`, source:"staged".
 *
 * Limit: default 5, max 8. Scope: default 'project'. Invalid cursor → INVALID_REFERENCE.
 */

import type { MemoryRecord } from '../../contracts/memory.js';
import type { RecallRequest, RecallResponse } from '../../contracts/tools.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import type { MemoryRow } from '../../db/memoryRepository.js';
import { toMemoryRecord, toStagedRecord } from '../memoryMapper.js';
import {
  fuseRrf,
  prioritizeRepo,
  encodeOffsetCursor,
  decodeOffsetCursor,
  RRF_CANDIDATES,
} from '../../search/rrf.js';
import { logger } from '../../observability/logger.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

export async function recallHandler(
  input: RecallRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<RecallResponse> {
  const scope: 'repo' | 'project' = input.scope ?? 'project';
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = input.cursor ?? null;
  // Decode first so a malformed cursor fails before any query runs.
  const offset = cursor === null ? 0 : decodeOffsetCursor(cursor);
  // Normalize empty array to undefined so the repository sees "no filter"
  // (an empty [] would match zero rows in SQL: m.type = ANY([])).
  const types = input.types && input.types.length ? input.types : undefined;

  const [lexical, semantic] = await Promise.all([
    deps.memoryRepository.recallLexicalCandidates(
      ctx.tenant,
      { query: input.query, scope, types },
      RRF_CANDIDATES,
    ),
    recallSemanticFailSoft(input.query, scope, types, ctx, deps),
  ]);

  const fused = fuseRrf(lexical, semantic);
  const ranked = scope === 'project' ? prioritizeRepo(fused, ctx.tenant.repoId) : fused;

  const page = ranked.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const mainRecords = page.map((f) => toMemoryRecord(f.row));

  // Staged-mix: own open-session drafts on the first page only, capped at `limit`.
  const stagedRecords: MemoryRecord[] =
    cursor === null
      ? (await deps.stagingRepository.listStagingItems(ctx.tenant))
          .slice(0, limit)
          .map((item) => toStagedRecord(item, ctx.tenant.branch))
      : [];

  return {
    results: [...stagedRecords, ...mainRecords],
    total_matches: ranked.length,
    cursor: nextOffset < ranked.length ? encodeOffsetCursor(nextOffset) : null,
  };
}

/** Semantic candidate list; any failure degrades to an empty list plus a warning. */
async function recallSemanticFailSoft(
  query: string,
  scope: 'repo' | 'project',
  types: RecallRequest['types'],
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<MemoryRow[]> {
  try {
    const queryEmbedding = await deps.embedder.embed(query);
    return await deps.memoryRepository.recallSemantic(
      ctx.tenant,
      queryEmbedding,
      { scope, types },
      [],
      RRF_CANDIDATES,
    );
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    logger.warn(`[recall] semantic side failed (${errorName}) — returning lexical-only`);
    return [];
  }
}
