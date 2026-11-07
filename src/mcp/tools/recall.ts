/**
 * recall tool handler — contract §2 / §8.
 *
 * Two-phase hybrid recall: BM25-first, semantic fallback.
 *
 * Phase 1 (always): FTS + time-decay keyset-paginated BM25 recall (UNCHANGED).
 * Phase 2 (first page only, fail-soft): if BM25 totalMatches < N, embed the
 * query and run a pure vector nearest-neighbour scan via recallSemantic; append
 * results after BM25 rows. Any embed error silently skips Phase 2 (BM25-only).
 *
 * First page result order: staged drafts → BM25 results → semantic extras.
 * Cursor pages: BM25 only (no staged, no semantic).
 *
 * total_matches always reflects the BM25 FTS count (semantic extras are additive
 * and do not change the pagination count or the cursor semantics).
 *
 * Limit normalization: default 8, max 50 (contract §2/§8).
 * Scope normalization: default 'project' (contract §2).
 * Cursor: opaque base64url token from a prior response; null on the first page.
 */

import type { MemoryRecord } from '../../contracts/memory.js';
import type { RecallRequest, RecallResponse } from '../../contracts/tools.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import { toMemoryRecord, toStagedRecord } from '../memoryMapper.js';
import { logger } from '../../observability/logger.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

export async function recallHandler(
  input: RecallRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<RecallResponse> {
  const scope: 'repo' | 'project' = input.scope ?? 'project';
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = input.cursor ?? null;
  // Normalize empty array to undefined so the repository sees "no filter"
  // (an empty [] would match zero rows in SQL: m.type = ANY([])).
  const types = input.types && input.types.length ? input.types : undefined;

  // Phase 1 — BM25 (existing recall, UNCHANGED)
  const result = await deps.memoryRepository.recall(ctx.tenant, {
    query: input.query,
    scope,
    types,
    limit,
    cursor,
  });
  const bm25Records = result.rows.map((row) => toMemoryRecord(row));

  // Phase 2 — semantic fallback: first page only, only when BM25 came up short, fail-soft
  let semanticRecords: MemoryRecord[] = [];
  if (cursor === null && result.totalMatches < deps.semanticFallbackMinResults) {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await deps.embedder.embed(input.query);
    } catch {
      logger.warn('[recall] query embedding failed — skipping semantic fallback (BM25-only)');
    }
    if (queryEmbedding !== null) {
      try {
        const excludeIds = result.rows.map((r) => r.id);
        const vectorRows = await deps.memoryRepository.recallSemantic(
          ctx.tenant,
          queryEmbedding,
          { scope, types },
          excludeIds,
          deps.semanticFallbackK,
        );
        semanticRecords = vectorRows.map((row) => toMemoryRecord(row));
        if (semanticRecords.length > 0) {
          logger.debug(`[recall] semantic fallback appended ${semanticRecords.length} hit(s)`);
        }
      } catch {
        logger.warn('[recall] semantic phase failed — returning BM25-only');
        // semanticRecords stays as the already-initialized empty array
      }
    }
  }

  // Staged-mix: prepend open-session drafts on the first page only.
  // Cursor pages skip the fetch to keep keyset pagination over `memory` pristine.
  // total_matches reflects main results only (staged drafts and semantic extras are additive, not counted).
  const stagedRecords: MemoryRecord[] = cursor === null
    ? (await deps.stagingRepository.listStagingItems(ctx.tenant)).map(
        (item) => toStagedRecord(item, ctx.tenant.branch),
      )
    : [];

  return {
    results: [...stagedRecords, ...bm25Records, ...semanticRecords],
    total_matches: result.totalMatches,   // BM25 FTS count; semantic hits are additive extras
    cursor: result.nextCursor,             // BM25 keyset cursor — UNCHANGED
  };
}
