/**
 * discard_staged tool handler — contract §5.
 *
 * Deletes one staging item from the caller's own open session. Returns
 * { discarded: true } on success. Throws an opaque INVALID_REFERENCE when
 * the item is not found — deliberately does not reveal whether the item
 * exists in a different session (no enumeration oracle).
 *
 * Pure handler: no auth, audit, or registration — the registerWriteTools
 * wrapper handles those concerns.
 */

import type { DiscardStagedRequest, DiscardStagedResponse } from '../../contracts/tools.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import { AppError, ErrorCode } from '../../errors/appError.js';

export async function discardStagedHandler(
  input: DiscardStagedRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<DiscardStagedResponse> {
  const ok = await deps.stagingRepository.discardStagingItem(ctx.tenant, input.item_id);
  if (!ok) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }
  return { discarded: true };
}
