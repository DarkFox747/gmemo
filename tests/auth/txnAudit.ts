/**
 * Test helpers for the C11 transaction-scoped audit hooks.
 *
 * Fakes emulate a repository write: they run the caller's hook BEFORE mutating
 * their in-memory state, so a failing hook leaves the fake unchanged (as the
 * real ROLLBACK does). The hook gets FAKE_TXN as its client; the in-memory
 * audit sink (InMemoryAuthRepository) ignores the client, and anything that
 * tried to run SQL on it fails loudly.
 */

import type { SqlExecutor } from '../../src/db/authRepository.js';
import type { ApiAuditDetail, ApiWriteAudit } from '../../src/mcp/context.js';
import type { ItemWrite } from '../../src/db/promotionRepository.js';
import type { ItemResult, PromoteItemOptions } from '../../src/promote/promoteService.js';

export const FAKE_TXN = {
  query: () => Promise.reject(new Error('FAKE_TXN cannot run SQL')),
} as unknown as SqlExecutor;

/** An ApiWriteAudit that records every detail it is handed (service unit tests). */
export function recordingAudit(): { audit: ApiWriteAudit; details: ApiAuditDetail[] } {
  const details: ApiAuditDetail[] = [];
  return {
    details,
    audit: (_db, detail) => {
      details.push(detail);
      return Promise.resolve();
    },
  };
}

/** The terminal write a scripted promoteItem result implies; null when nothing was written. */
function itemWriteOf(r: ItemResult, memoryStatus: string): ItemWrite | null {
  if (r.outcome === 'applied' && r.memoryId !== null) {
    return { outcome: 'applied', memoryId: r.memoryId, deduped: r.deduped, memoryStatus };
  }
  if (r.outcome === 'quarantined' && r.quarantineId !== null) {
    return { outcome: 'quarantined', quarantineId: r.quarantineId };
  }
  if (r.outcome === 'queued') return { outcome: 'queued' };
  return null;
}

/** Runs opts.audit as the scripted result's terminal write would (scripted promoteItem fakes). */
export async function runItemAudit(
  r: ItemResult,
  opts: PromoteItemOptions | undefined,
  memoryStatus = 'active',
): Promise<void> {
  const w = itemWriteOf(r, memoryStatus);
  if (w && opts?.audit) await opts.audit(FAKE_TXN, w);
}
