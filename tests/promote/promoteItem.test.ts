/**
 * PromoteService.promoteItem (C3 restore) + terminalStatus.
 * Same per-item pipeline as promote(): outcomes carry ids, the session is
 * finalized, notifications fire as in promotion, and nothing is audited.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { terminalStatus, type ItemOrigin } from '../../src/promote/promoteService.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { logger } from '../../src/observability/logger.js';
import { SESSION_ID, accepted, makeItem, makeService, rejected } from './fakes.js';

const ORIGIN: ItemOrigin = {
  tenant: { projectId: 'proj-1', repoId: 'repo-1', branch: 'restore/q-1' },
  originBranch: 'restore/q-1',
  originPr: 42,
};

afterEach(() => vi.restoreAllMocks());

describe('PromoteService.promoteItem', () => {
  it('applied → memoryId; session finalized promoted; no audit', async () => {
    const { service, repo, auditLogger } = makeService([makeItem('i1')], { results: [accepted()] });
    const r = await service.promoteItem(SESSION_ID, 'i1', ORIGIN);
    expect(r).toEqual({ outcome: 'applied', memoryId: 'mem-i1', deduped: false });
    expect(repo.finalizeCalls).toEqual([{ sessionId: SESSION_ID, status: 'promoted' }]);
    expect(auditLogger.recordPromoteCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls[0]!.ctx).toEqual({
      projectId: 'proj-1',
      repoId: 'repo-1',
      originBranch: 'restore/q-1',
      originPr: 42,
      sessionId: SESSION_ID,
    });
  });

  it('queued (mandatory type) → itemId; session partially_promoted; review_enqueued', async () => {
    const { service, repo, notifier } = makeService([makeItem('i2', { type: 'decision' })]);
    const r = await service.promoteItem(SESSION_ID, 'i2', ORIGIN);
    expect(r).toEqual({ outcome: 'queued', itemId: 'i2' });
    expect(repo.finalizeCalls[0]!.status).toBe('partially_promoted');
    expect(notifier.ofType('review_enqueued')).toHaveLength(1);
  });

  it('quarantined → the new quarantine id; session rejected', async () => {
    const { service, repo } = makeService([makeItem('i3')], { results: [rejected('specificity')] });
    const r = await service.promoteItem(SESSION_ID, 'i3', ORIGIN);
    expect(r).toEqual({ outcome: 'quarantined', itemId: 'i3', quarantineId: 'q-i3-1' });
    expect(repo.finalizeCalls[0]!.status).toBe('rejected');
  });

  it('a secret → quarantined spans and leak_detected fires, judge not called', async () => {
    const { service, repo, judge, notifier } = makeService([
      makeItem('i4', { body: 'Key AKIAIOSFODNN7EXAMPLE in src/x.ts' }),
    ]);
    const r = await service.promoteItem(SESSION_ID, 'i4', ORIGIN);
    expect(r.outcome).toBe('quarantined');
    expect(repo.quarantineCalls[0]!.q.redact).toBe('spans');
    expect(judge.evaluateCalls).toHaveLength(0);
    expect(notifier.ofType('leak_detected')).toHaveLength(1);
  });

  it('only the claimed item is processed (a stray item in the session is left alone)', async () => {
    const { service, repo } = makeService([makeItem('stray'), makeItem('i5')]);
    await service.promoteItem(SESSION_ID, 'i5', ORIGIN);
    expect(repo.applyAcceptedCalls.map((c) => c.item.id)).toEqual(['i5']);
  });

  it('item absent → logged and INTERNAL; session not finalized', async () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { service, repo } = makeService([makeItem('other')]);
    const p = service.promoteItem(SESSION_ID, 'missing', ORIGIN);
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    expect(err).toHaveBeenCalledWith('[promote] single-item run: item not promotable', {
      sessionId: SESSION_ID,
      itemId: 'missing',
    });
    expect(repo.finalizeCalls).toHaveLength(0);
  });
});

describe('terminalStatus', () => {
  it.each([
    [{ applied: 1, queued: 0, total: 1 }, 'promoted'],
    [{ applied: 0, queued: 0, total: 1 }, 'rejected'],
    [{ applied: 0, queued: 1, total: 1 }, 'partially_promoted'],
    [{ applied: 1, queued: 1, total: 3 }, 'partially_promoted'],
    [{ applied: 3, queued: 0, total: 3 }, 'promoted'],
  ] as const)('%o → %s', (c, expected) => {
    expect(terminalStatus(c)).toBe(expected);
  });
});
