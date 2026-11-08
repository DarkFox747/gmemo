import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewService } from '../../src/review/reviewService.js';
import {
  ACTOR,
  FakeEmbedder,
  FakePromotionRepo,
  FakeQueueRepo,
  makeItem,
  makeRef,
} from './fakes.js';

let queue: FakeQueueRepo;
let promo: FakePromotionRepo;
let embedder: FakeEmbedder;
let svc: ReviewService;

const NO_FLAGS = { markRelatedSuperseded: false };

beforeEach(() => {
  queue = new FakeQueueRepo();
  promo = new FakePromotionRepo();
  embedder = new FakeEmbedder();
  svc = new ReviewService({
    reviewQueueRepository: queue,
    promotionRepository: promo,
    embedder,
    confidenceThreshold: 0.8,
  });
});

describe('ReviewService.list', () => {
  it('maps rows to camelCase DTOs with ISO timestamps and passes counters/truncated', async () => {
    queue.rows = [makeItem()];
    queue.truncated = true;
    const out = await svc.list('p1', { filter: 'all', limit: 10 });
    expect(out.truncated).toBe(true);
    expect(out.counters).toEqual({ pending: 2, uncertain: 1, mandatory: 1, resolvedLast7Days: 5 });
    expect(out.items[0]).toMatchObject({
      id: 'item-1',
      judgeState: 'uncertain',
      mandatoryReview: false,
      originBranch: 'feat/x',
      originPr: 7,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });
});

describe('ReviewService.get', () => {
  it('returns null when the item is not queued', async () => {
    expect(await svc.get('p1', 'x')).toBeNull();
  });

  it('add op: no target, targetStale false, threshold from config', async () => {
    queue.item = makeItem();
    const d = await svc.get('p1', 'item-1');
    expect(d?.threshold).toBe(0.8);
    expect(d?.target).toBeNull();
    expect(d?.targetStale).toBe(false);
    expect(d?.reason).toBe('why');
  });

  it('amend: current revision equal to item target_revision is not stale', async () => {
    queue.item = makeItem({ op: 'amend', target_memory_id: 'mem-1', target_revision: 3 });
    queue.refs = [makeRef()];
    const d = await svc.get('p1', 'item-1');
    expect(d?.targetStale).toBe(false);
    expect(d?.target).toMatchObject({
      id: 'mem-1',
      version: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('amend: moved revision, inactive or missing target are stale', async () => {
    queue.item = makeItem({ op: 'amend', target_memory_id: 'mem-1', target_revision: 2 });
    queue.refs = [makeRef()];
    expect((await svc.get('p1', 'item-1'))?.targetStale).toBe(true);

    queue.item = makeItem({ op: 'amend', target_memory_id: 'mem-1', target_revision: 3 });
    queue.refs = [makeRef({ status: 'superseded' })];
    expect((await svc.get('p1', 'item-1'))?.targetStale).toBe(true);

    queue.refs = [];
    expect((await svc.get('p1', 'item-1'))?.targetStale).toBe(true);
  });

  it('maps the related memory', async () => {
    queue.item = makeItem({ related_memory_id: 'mem-1' });
    queue.refs = [makeRef()];
    expect((await svc.get('p1', 'item-1'))?.related?.id).toBe('mem-1');
  });
});

describe('ReviewService.approve', () => {
  it('not_found when the item is not queued; no embedding, no approve call', async () => {
    const out = await svc.approve(ACTOR, 'p1', 'x', NO_FLAGS);
    expect(out).toEqual({ kind: 'not_found' });
    expect(embedder.calls).toHaveLength(0);
    expect(promo.approveInputs).toHaveLength(0);
  });

  it('passes embedding, expected hash and reviewer; maps the approved result and audit', async () => {
    queue.item = makeItem();
    const out = await svc.approve(ACTOR, 'p1', 'item-1', {
      markRelatedSuperseded: true,
      targetRevision: 4,
    });
    expect(promo.approveInputs[0]).toEqual({
      projectId: 'p1',
      itemId: 'item-1',
      reviewerUserId: 'user-1',
      expectedContentHash: 'h1',
      embedding: [0.1, 0.2],
      targetRevision: 4,
      markRelatedSuperseded: true,
    });
    expect(out).toEqual({
      kind: 'approved',
      dto: {
        itemId: 'item-1',
        decision: 'approved',
        memoryId: 'mem-9',
        deduped: false,
        rebasedFromRevision: null,
        relatedSuperseded: false,
      },
      audit: {
        itemId: 'item-1',
        memoryId: 'mem-9',
        decision: 'approved',
        deduped: false,
        relatedSuperseded: false,
      },
    });
  });

  it('includes rebase revisions in dto and audit', async () => {
    queue.item = makeItem({ op: 'amend', target_memory_id: 'mem-1', target_revision: 2 });
    promo.approveResult = {
      status: 'approved',
      memoryId: 'mem-1',
      deduped: false,
      rebasedFromRevision: 2,
      rebasedToRevision: 3,
      relatedSuperseded: true,
    };
    const out = await svc.approve(ACTOR, 'p1', 'item-1', {
      markRelatedSuperseded: false,
      targetRevision: 3,
    });
    expect(out.kind).toBe('approved');
    if (out.kind === 'approved') {
      expect(out.dto.rebasedFromRevision).toBe(2);
      expect(out.audit).toMatchObject({ rebasedFromRevision: 2, rebasedToRevision: 3 });
    }
  });

  it('targetRevision defaults to null when not supplied', async () => {
    queue.item = makeItem();
    await svc.approve(ACTOR, 'p1', 'item-1', NO_FLAGS);
    expect(promo.approveInputs[0]!.targetRevision).toBeNull();
  });

  it('maps repository not_found and conflict codes', async () => {
    queue.item = makeItem();
    promo.approveResult = { status: 'not_found' };
    expect(await svc.approve(ACTOR, 'p1', 'item-1', NO_FLAGS)).toEqual({ kind: 'not_found' });
    promo.approveResult = { status: 'conflict', code: 'target_changed' };
    expect(await svc.approve(ACTOR, 'p1', 'item-1', NO_FLAGS)).toEqual({
      kind: 'conflict',
      code: 'target_changed',
    });
  });

  it('embedding failure is fail-soft: approve proceeds with a null embedding', async () => {
    queue.item = makeItem();
    embedder.fail = true;
    const out = await svc.approve(ACTOR, 'p1', 'item-1', NO_FLAGS);
    expect(out.kind).toBe('approved');
    expect(promo.approveInputs[0]!.embedding).toBeNull();
  });

  it('deprecate: embedder is never called, embedding is null', async () => {
    queue.item = makeItem({ op: 'deprecate', target_memory_id: 'mem-1', target_revision: 3 });
    await svc.approve(ACTOR, 'p1', 'item-1', NO_FLAGS);
    expect(embedder.calls).toHaveLength(0);
    expect(promo.approveInputs[0]!.embedding).toBeNull();
  });
});

describe('ReviewService.reject', () => {
  it('rejects a reason containing a secret as invalid_reason without storing it', async () => {
    const out = await svc.reject(ACTOR, 'p1', 'item-1', {
      reason: 'leaked key AKIAIOSFODNN7EXAMPLE in body',
    });
    expect(out).toEqual({ kind: 'invalid_reason' });
    expect(promo.rejectInputs).toHaveLength(0);
  });

  it('masks PII before storage', async () => {
    const out = await svc.reject(ACTOR, 'p1', 'item-1', { reason: 'contact jane.doe@example.com' });
    expect(out).toEqual({ kind: 'rejected', dto: { itemId: 'item-1', decision: 'rejected' } });
    expect(promo.rejectInputs[0]!.reason).not.toContain('jane.doe@example.com');
    expect(promo.rejectInputs[0]).toMatchObject({
      projectId: 'p1',
      itemId: 'item-1',
      reviewerUserId: 'user-1',
    });
  });

  it('maps repository not_found', async () => {
    promo.rejectResult = 'not_found';
    expect(await svc.reject(ACTOR, 'p1', 'item-1', { reason: 'not relevant' })).toEqual({
      kind: 'not_found',
    });
  });
});
