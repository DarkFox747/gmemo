/**
 * T018: PromoteService unit tests (orchestration state machine).
 *
 * DB-free: uses the shared stateful fakes in ./fakes.ts. Spec-scenario coverage
 * (HU-05/06/11.3, idempotency) lives in promoteVerdict.test.ts; this file keeps
 * the orchestration cases:
 *  - empty items → no_op (finalizeSession + recordPromote not called)
 *  - pending accepted → recordDecision then applyAccepted; deduped counted
 *  - judge rejected (specificity) → quarantine with the judge criterion
 *  - judge uncertain → recordDecision(uncertain); no apply, no quarantine
 *  - applyAccepted results: applied / stale→queue / duplicate→quarantine / already→applied
 *  - sanitize gate: secrets in body/title/fields → secret_detected, redact; judge not called
 *  - persisted-decision reuse (accepted / uncertain / rejected)
 *  - terminal status + audit counters
 */

import { describe, it, expect } from 'vitest';
import type { ApplyResult } from '../../src/db/promotionRepository.js';
import { makeItem, makeService, accepted, rejected, uncertain, META, SESSION_ID } from './fakes.js';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

describe('PromoteService.promote — empty items', () => {
  it('returns no_op with zero counters when fetchPromotableItems is empty', async () => {
    const { service, repo, auditLogger } = makeService([]);
    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toEqual({
      status: 'no_op',
      applied: 0,
      deduped: 0,
      quarantined: 0,
      uncertain: 0,
    });
    expect(repo.finalizeCalls).toHaveLength(0);
    expect(auditLogger.recordPromoteCalls).toHaveLength(0);
  });
});

describe('PromoteService.promote — accepted verdict → apply', () => {
  it('records the decision, applies the item and increments applied', async () => {
    const { service, repo, judge } = makeService([makeItem('item-1')]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toEqual({
      status: 'promoted',
      applied: 1,
      deduped: 0,
      quarantined: 0,
      uncertain: 0,
    });
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls[0]!.item.id).toBe('item-1');
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(repo.decisionCalls).toHaveLength(1);
    expect(repo.decisionCalls[0]!.d.verdict).toBe('accepted');
    expect(judge.evaluateCalls).toHaveLength(1);
  });

  it('increments deduped when applyAccepted returns deduped=true', async () => {
    const applyResults = new Map<string, ApplyResult>([
      ['item-dedup', { status: 'applied', memoryId: 'mem-existing', deduped: true }],
    ]);
    const { service } = makeService([makeItem('item-dedup')], { applyResults });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);
    expect(outcome.deduped).toBe(1);
  });
});

describe('PromoteService.promote — rejected verdict → quarantine', () => {
  it('quarantines with the judge criterion (specificity), never applies', async () => {
    const { service, repo } = makeService([makeItem('item-rej')], {
      results: [rejected('specificity')],
    });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ status: 'rejected', quarantined: 1, applied: 0, uncertain: 0 });
    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.q.reason).toBe('specificity');
    expect(repo.quarantineCalls[0]!.q.redact).toBe(false);
    expect(repo.quarantineCalls[0]!.q.decision!.criterion).toBe('specificity');
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    // The quarantine write is the only state write (no pre-quarantine recordDecision).
    expect(repo.decisionCalls).toHaveLength(0);
  });
});

describe('PromoteService.promote — uncertain verdict (fail-closed)', () => {
  it('records uncertain, does not apply or quarantine', async () => {
    const { service, repo } = makeService([makeItem('item-unc')], {
      results: [uncertain('grounding')],
    });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ uncertain: 1, applied: 0, quarantined: 0 });
    expect(repo.decisionCalls[0]!.d.verdict).toBe('uncertain');
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);
  });

  it('one applied + one uncertain → partially_promoted', async () => {
    const { service } = makeService([makeItem('a'), makeItem('u')], {
      results: [accepted(), uncertain('confidence')],
    });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ applied: 1, uncertain: 1, status: 'partially_promoted' });
  });
});

describe('PromoteService.promote — applyAccepted result routing', () => {
  it('stale → review queue (uncertain/stale_target), NOT quarantine', async () => {
    const applyResults = new Map<string, ApplyResult>([['item-stale', { status: 'stale' }]]);
    const { service, repo } = makeService([makeItem('item-stale')], { applyResults });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({
      uncertain: 1,
      quarantined: 0,
      applied: 0,
      status: 'partially_promoted',
    });
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(repo.decisionCalls.at(-1)!.d).toMatchObject({
      criterion: 'stale_target',
      mandatoryReview: true,
    });
  });

  it('duplicate → quarantine duplicate_content (no redact)', async () => {
    const applyResults = new Map<string, ApplyResult>([['item-dup', { status: 'duplicate' }]]);
    const { service, repo } = makeService([makeItem('item-dup')], { applyResults });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ quarantined: 1, applied: 0 });
    expect(repo.quarantineCalls[0]!.q.reason).toBe('duplicate_content');
    expect(repo.quarantineCalls[0]!.q.redact).toBe(false);
  });

  it('already → counted as applied', async () => {
    const applyResults = new Map<string, ApplyResult>([['item-already', { status: 'already' }]]);
    const { service, repo } = makeService([makeItem('item-already')], { applyResults });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({ applied: 1, quarantined: 0 });
    expect(repo.applyAcceptedCalls).toHaveLength(1);
  });
});

describe('PromoteService.promote — sanitize gate (secrets)', () => {
  it.each([
    ['body', { body: `Found this key: ${AWS_KEY} — do not use.` }],
    ['title', { title: '-----BEGIN RSA PRIVATE KEY----- key mgmt' }],
    ['fields', { fields: { apiKey: AWS_KEY } }],
  ])('secret in %s → secret_detected, redact; judge never called', async (_l, overrides) => {
    const { service, repo, judge } = makeService([makeItem('item-s', overrides)]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(repo.quarantineCalls[0]!.q.reason).toBe('secret_detected');
    expect(repo.quarantineCalls[0]!.q.redact).toBe(true);
    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
  });

  it('a persisted accepted item is re-sanitized: a secret body is quarantined, never applied', async () => {
    const item = makeItem('item-prescan', {
      judge_state: 'accepted',
      judge_criterion: 'confidence',
      judge_confidence: 0.9,
      body: `${AWS_KEY} — secret, but this item was already accepted.`,
    });
    const { service, repo, judge } = makeService([item]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(judge.evaluateCalls).toHaveLength(0);
  });
});

describe('PromoteService.promote — persisted-decision reuse', () => {
  it("judge_state='accepted' (confidence 0.9) → judge not re-called; applied without a new decision write", async () => {
    const item = makeItem('pre-a', {
      judge_state: 'accepted',
      judge_criterion: 'confidence',
      judge_confidence: 0.9,
    });
    const { service, repo, judge } = makeService([item], { results: [rejected('specificity')] });

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.decisionCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(outcome.applied).toBe(1);
  });

  it("legacy judge_state='accepted' with null confidence → queued, never applied", async () => {
    const item = makeItem('pre-legacy', { judge_state: 'accepted' });
    const { service, repo, judge, notifier } = makeService([item]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(outcome.uncertain).toBe(1);
    expect(repo.decisionCalls[0]!.d).toMatchObject({
      verdict: 'uncertain',
      criterion: 'confidence',
    });
    expect(notifier.events).toHaveLength(1);
  });

  it("judge_state='uncertain' → judge not re-called; left queued; no write, no notify", async () => {
    const item = makeItem('pre-u', { judge_state: 'uncertain', judge_criterion: 'grounding' });
    const { service, repo, judge, notifier } = makeService([item]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.decisionCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(notifier.events).toHaveLength(0);
    expect(outcome.uncertain).toBe(1);
  });

  it("judge_state='rejected' → skipped entirely", async () => {
    const { service, repo, judge } = makeService([makeItem('pre-r', { judge_state: 'rejected' })]);

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.decisionCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(outcome).toMatchObject({ applied: 0, quarantined: 0, status: 'rejected' });
  });
});

describe('PromoteService.promote — terminal status', () => {
  it("all applied → 'promoted'", async () => {
    const { service, repo } = makeService([makeItem('t1'), makeItem('t2')]);
    expect((await service.promote(SESSION_ID, META)).status).toBe('promoted');
    expect(repo.finalizeCalls).toEqual([{ sessionId: SESSION_ID, status: 'promoted' }]);
  });

  it("all quarantined → 'rejected'", async () => {
    const { service, repo } = makeService([makeItem('t3'), makeItem('t4')], {
      results: [rejected('specificity')],
    });
    expect((await service.promote(SESSION_ID, META)).status).toBe('rejected');
    expect(repo.finalizeCalls[0]!.status).toBe('rejected');
  });

  it("applied + quarantined → 'partially_promoted'", async () => {
    const { service } = makeService([makeItem('t5'), makeItem('t6')], {
      results: [accepted(), rejected('specificity')],
    });
    const outcome = await service.promote(SESSION_ID, META);
    expect(outcome).toMatchObject({ status: 'partially_promoted', applied: 1, quarantined: 1 });
  });
});

describe('PromoteService.promote — auditLogger.recordPromote', () => {
  it('called once with correct counters and tenant context', async () => {
    const { service, auditLogger } = makeService([makeItem('a1'), makeItem('a2'), makeItem('a3')], {
      results: [accepted(), rejected('specificity'), uncertain('grounding')],
    });

    await service.promote(SESSION_ID, META);

    expect(auditLogger.recordPromoteCalls).toHaveLength(1);
    const { ctx, p } = auditLogger.recordPromoteCalls[0]!;
    expect(p).toEqual({
      sessionId: SESSION_ID,
      applied: 1,
      quarantined: 1,
      uncertain: 1,
      prNumber: META.originPr,
      mergeSha: META.mergeSha,
    });
    expect(ctx.tenant.projectId).toBe(META.tenant.projectId);
    expect(ctx.actor.actorId).toBe(META.actor.actorId);
  });
});

describe('PromoteService.promote — mixed multi-item', () => {
  it('each item goes through sanitize → judge independently; persisted items are not re-judged', async () => {
    const items = [
      makeItem('mix-1'),
      makeItem('mix-2'),
      makeItem('mix-3', { body: `Leaked: ${AWS_KEY} should not be here.` }),
      makeItem('pre-r', { judge_state: 'rejected' }),
    ];
    const { service, repo, judge } = makeService(items, {
      results: [accepted(), uncertain('confidence')],
    });

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome).toMatchObject({
      applied: 1,
      uncertain: 1,
      quarantined: 1,
      status: 'partially_promoted',
    });
    expect(judge.evaluateCalls).toHaveLength(2);
    expect(repo.quarantineCalls.map((c) => c.item.id)).toEqual(['mix-3']);
  });
});
