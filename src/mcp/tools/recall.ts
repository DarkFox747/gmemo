/**
 * recall tool handler — contract §2 / §8.
 *
 * Hybrid recall by Reciprocal Rank Fusion (HU-08.1):
 *   - lexical top-50 (BM25 with time-decay) and semantic top-50 (pgvector cosine),
 *     both filtered by project, status='active', types and scope;
 *   - fused with score = Σ 1/(60 + rank), ties broken by memory id (src/search/rrf.ts);
 *   - with scope=project the query's repo comes first (HU-08.3), then the rest.
 *
 * Ranking (both candidate lists, fusion, repo priority, fail-soft semantic side)
 * lives in rankActiveMemories (src/search/hybridSearch.ts) — the one search path
 * shared with the web search explorer. This handler ignores its `semantic` flag
 * and the rank-provenance fields.
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
import { toMemoryRecord, toStagedRecord } from '../memoryMapper.js';
import { encodeOffsetCursor, decodeOffsetCursor } from '../../search/rrf.js';
import { rankActiveMemories } from '../../search/hybridSearch.js';

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

  const { ranked } = await rankActiveMemories(deps, ctx.tenant, {
    query: input.query,
    scope,
    types,
  });

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
