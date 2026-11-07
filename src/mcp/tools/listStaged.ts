/**
 * list_staged tool handler — contract §4.
 *
 * Returns all staging items in the caller's own open session, projected to
 * the lightweight StagedItemView shape. Returns { items: [] } when no open
 * session exists (listStagingItems returns an empty array in that case).
 *
 * Pure handler: no auth, audit, or registration — the registerWriteTools
 * wrapper handles those concerns.
 */

import type { ListStagedResponse, StagedItemView } from '../../contracts/tools.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import type { StagingItemRow } from '../../db/stagingRepository.js';

/** Projects a staging_item row to the StagedItemView contract shape. */
function toStagedItemView(row: StagingItemRow): StagedItemView {
  return {
    id: row.id,
    op: row.op,
    type: row.type,
    title: row.title,
    summary: row.summary,
    state: row.judge_state,
    date: row.created_at.toISOString(),
  };
}

export async function listStagedHandler(
  _input: Record<string, never>,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<ListStagedResponse> {
  const rows = await deps.stagingRepository.listStagingItems(ctx.tenant);
  return { items: rows.map(toStagedItemView) };
}
