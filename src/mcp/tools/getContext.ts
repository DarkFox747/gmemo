/**
 * get_context tool handler — contract §2 / §8.
 *
 * Two-phase retrieval (D6):
 *  Phase 1 — constraints + domain_rules (project-scoped, all active):
 *    Always returned in full; NEVER budget-dropped (contract §2).
 *  Phase 2 — decisions + gotchas (recency-ordered candidate set):
 *    Trimmed by an approximate ~2500-token budget, keeping whole records only.
 *    `stale` (TTL-expired-but-active) is computed in SQL for both phases.
 *
 * Token estimate (per record): ceil((title+summary+body+JSON.stringify(fields)).length / 4).
 * Phase-1 records are counted separately and may push the total above budget by design.
 */

import type { GetContextRequest, GetContextResponse } from '../../contracts/tools.js';
import type { MemoryRecord } from '../../contracts/memory.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import type { MemoryRow } from '../../db/memoryRepository.js';
import { toMemoryRecord } from '../memoryMapper.js';

/** Approximate token budget for phase-2 records (contract §8). */
const GET_CONTEXT_TOKEN_BUDGET = 2500;

/**
 * Candidate limit passed to the DB for phase-2. Enough that the budget will
 * trim before the DB limit is reached in most cases, while keeping the query
 * result set bounded.
 */
const PHASE2_CANDIDATE_LIMIT = 50;

/** Rough token estimate for a single memory row (chars / 4, rounded up). */
function estimateTokens(row: MemoryRow): number {
  const text = row.title + row.summary + row.body + JSON.stringify(row.fields);
  return Math.ceil(text.length / 4);
}

export async function getContextHandler(
  _input: GetContextRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<GetContextResponse> {
  const contextRecords = await deps.memoryRepository.getContextRecords(
    ctx.tenant,
    PHASE2_CANDIDATE_LIMIT,
  );

  // Phase 1: constraints + domain_rules — always included, never budget-dropped.
  const phase1Records: MemoryRecord[] = contextRecords.phase1.map((row) =>
    toMemoryRecord(row, { stale: row.stale }),
  );

  // Phase 2: decisions + gotchas — trim to the token budget (whole records only).
  let tokenCount = 0;
  const phase2Records: MemoryRecord[] = [];
  for (const row of contextRecords.phase2) {
    const estimate = estimateTokens(row);
    if (tokenCount + estimate > GET_CONTEXT_TOKEN_BUDGET) break;
    tokenCount += estimate;
    phase2Records.push(toMemoryRecord(row, { stale: row.stale }));
  }

  return {
    records: [...phase1Records, ...phase2Records],
  };
}
