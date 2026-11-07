/**
 * get_memory tool handler — contract §2 / §6.
 *
 * Decodes the opaque handle → (memoryId, revisionNo); fetches the active
 * memory + bidirectional relations from RDS (project-scoped); maps to the
 * contract response shape.
 *
 * Any of the following → ONE opaque AppError(INVALID_REFERENCE) (contract §6):
 *  - malformed handle (decodeHandle throws)
 *  - memory absent / non-active / cross-project (getMemoryByHandle returns null)
 *  - handle revision !== current_revision (stale or impossible reverse)
 *
 * The caller never learns which condition failed (OWASP enumeration guard).
 *
 * references = de-duplicated opaque handles derived from the relation edges (D9).
 */

import type { GetMemoryRequest, GetMemoryResponse } from '../../contracts/tools.js';
import type { MemoryRelation } from '../../contracts/memory.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import { decodeHandle, isHandleStale, encodeHandle } from '../handle.js';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { toMemoryRecord } from '../memoryMapper.js';

export async function getMemoryHandler(
  input: GetMemoryRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<GetMemoryResponse> {
  // Throws AppError(INVALID_REFERENCE) on any malformed handle — no detail leaked.
  const decoded = decodeHandle(input.handle);

  const detail = await deps.memoryRepository.getMemoryByHandle(ctx.tenant, decoded.memoryId);

  // null = absent / non-active / cross-project; revision mismatch = stale or impossible.
  // All cases → one opaque reference error (contract §6).
  if (
    detail === null ||
    isHandleStale(detail.memory.current_revision, decoded.revisionNo) ||
    decoded.revisionNo > detail.memory.current_revision
  ) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }

  const memory = toMemoryRecord(detail.memory);

  const relations: MemoryRelation[] = detail.relations.map((r) => ({
    type: r.relation_type,
    handle: encodeHandle(r.other_id, r.other_current_revision),
  }));

  // de-duplicated flat list of handles the agent can pass to get_memory next (D9).
  const references: string[] = [...new Set(relations.map((r) => r.handle))];

  return { memory, relations, references };
}
