/**
 * Verify-round-1 remediation (C1, task 5.1) for the PromoteService:
 *  - SEC M-1: apply-time `review_required` (target type mismatch / mandatory
 *    target type) → mandatory review queue, notified once, never applied.
 *  - SEC L-1: an item that throws is logged by id + error name only, left
 *    pending, not counted, and the session is never finalized as promoted.
 *  - Reviewer M1: R3/R4 quarantines keep the judge justification on the staging row.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ApplyContext,
  ApplyResult,
  PromotionItemRow,
} from '../../src/db/promotionRepository.js';
import type { MemoryType } from '../../src/contracts/memory.js';
import { logger } from '../../src/observability/logger.js';
import { makeItem, makeService, rejected, DEFAULT_ROUTING, META, SESSION_ID } from './fakes.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SEC M-1 — apply-time target guard', () => {
  it('passes the configured mandatory types to applyAccepted', async () => {
    const { service, repo } = makeService([makeItem('a1')]);
    await service.promote(SESSION_ID, META);
    expect(repo.applyAcceptedCalls[0]!.mandatoryTypes).toBe(DEFAULT_ROUTING.mandatoryReviewTypes);
  });

  it('review_required → accepted + mandatory_review, queue mandatory, notified once, not applied', async () => {
    const item = makeItem('m1', { op: 'amend', target_memory_id: 'mem-t', target_revision: 1 });
    const applyResults = new Map<string, ApplyResult>([['m1', { status: 'review_required' }]]);
    const { service, repo, notifier } = makeService([item], { applyResults });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ status: 'partially_promoted', applied: 0, uncertain: 1 });
    const last = repo.decisionCalls.at(-1)!;
    expect(last.d).toMatchObject({
      verdict: 'accepted',
      criterion: 'confidence',
      mandatoryReview: true,
    });
    expect(repo.rows.get('m1')!.promoted_at).toBeNull();
    expect(notifier.ofType('review_enqueued')).toEqual([
      { type: 'review_enqueued', itemId: 'm1', queue: 'mandatory', criterion: 'confidence' },
    ]);

    // Re-run: persisted mandatory flag routes to the queue; no second apply/notify.
    const applyCount = repo.applyAcceptedCalls.length;
    await service.promote(SESSION_ID, META);
    expect(repo.applyAcceptedCalls).toHaveLength(applyCount);
    expect(notifier.ofType('review_enqueued')).toHaveLength(1);
  });

  it('known mandatory target type is queued before apply (routing)', async () => {
    const item = makeItem('m2', {
      op: 'amend',
      target_memory_id: 'mem-t',
      target_revision: 1,
      target_type: 'decision',
    });
    const { service, repo } = makeService([item]);
    const outcome = await service.promote(SESSION_ID, META);
    expect(outcome.uncertain).toBe(1);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
  });
});

describe('SEC L-1 — per-item failure isolation', () => {
  it('a throwing item is logged by id + error name, left pending, not counted; session partially_promoted', async () => {
    const { service, repo } = makeService([makeItem('ok-1'), makeItem('boom'), makeItem('ok-2')]);
    const original = repo.applyAccepted.bind(repo);
    repo.applyAccepted = (
      item: PromotionItemRow,
      ctx: ApplyContext,
      embedding: number[] | null,
      mandatoryTypes: ReadonlySet<MemoryType>,
    ) => {
      if (item.id === 'boom') return Promise.reject(new TypeError('secret-ish detail'));
      return original(item, ctx, embedding, mandatoryTypes);
    };
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toEqual({
      status: 'partially_promoted',
      applied: 2,
      deduped: 0,
      quarantined: 0,
      uncertain: 0,
    });
    expect(repo.rows.get('boom')!.promoted_at).toBeNull();
    expect(repo.finalizeCalls).toEqual([{ sessionId: SESSION_ID, status: 'partially_promoted' }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, data] = errorSpy.mock.calls[0]!;
    expect(data).toEqual({ itemId: 'boom', errorName: 'TypeError' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-ish detail');
  });

  it('a lone failing item never finalizes the session as rejected or promoted', async () => {
    const { service, repo } = makeService([makeItem('boom')]);
    repo.applyAccepted = () => Promise.reject(new Error('db down'));
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('partially_promoted');
    expect(repo.finalizeCalls[0]!.status).toBe('partially_promoted');
  });
});

describe('Reviewer M1 — judge justification kept on R3/R4 quarantines', () => {
  it.each([
    ['duplication', 'duplicate_content'],
    ['specificity', 'specificity'],
  ] as const)(
    '%s: staging judge_reason = judge reason, quarantine reason = code',
    async (criterion, code) => {
      const { service, repo } = makeService([makeItem('q1')], { results: [rejected(criterion)] });
      await service.promote(SESSION_ID, META);
      expect(repo.quarantineCalls[0]!.q.reason).toBe(code);
      expect(repo.rows.get('q1')!.judge_reason).toBe(`rejected: ${criterion}`);
    },
  );

  it('redacted security_second_layer keeps the constant on the staging row', async () => {
    const { service, repo } = makeService([makeItem('q2')], {
      results: [rejected('security_second_layer')],
    });
    await service.promote(SESSION_ID, META);
    expect(repo.rows.get('q2')!.judge_reason).toBe('security_second_layer');
  });
});
