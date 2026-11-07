/**
 * routeDecision unit tests — one case per row R1–R8 plus mandatory variants,
 * sticky mandatory_review, null confidence and the threshold boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  routeDecision,
  STALE_TARGET_DECISION,
  type RoutingConfig,
  type RoutingDecision,
  type RoutingItem,
} from '../../src/promote/routing.js';

const CFG: RoutingConfig = {
  confidenceThreshold: 0.8,
  mandatoryReviewTypes: new Set(['decision', 'constraint', 'domain_rule']),
};

const ITEM: RoutingItem = { op: 'add', type: 'pattern', mandatory_review: false };

function d(overrides: Partial<RoutingDecision>): RoutingDecision {
  return {
    verdict: 'accepted',
    criterion: 'confidence',
    confidence: 0.9,
    reason: 'model reason',
    relatedMemoryId: null,
    ...overrides,
  };
}

describe('routeDecision', () => {
  it('R1 stale_target → queue uncertain, mandatory, confidence null', () => {
    const r = routeDecision(d({ verdict: 'uncertain', criterion: 'stale_target' }), ITEM, CFG);
    expect(r).toEqual({
      kind: 'queue',
      queue: 'uncertain',
      persist: { ...STALE_TARGET_DECISION, confidence: null },
    });
    expect(STALE_TARGET_DECISION.mandatoryReview).toBe(true);
    expect(STALE_TARGET_DECISION.criterion).toBe('stale_target');
  });

  it('R2 rejected/security_second_layer → quarantine redact + leak; model reason not persisted', () => {
    const r = routeDecision(
      d({ verdict: 'rejected', criterion: 'security_second_layer', confidence: 0.95 }),
      ITEM,
      CFG,
    );
    expect(r).toEqual({
      kind: 'quarantine',
      reason: 'security_second_layer',
      redact: true,
      leak: true,
      persist: {
        verdict: 'rejected',
        criterion: 'security_second_layer',
        confidence: 0.95,
        reason: 'security_second_layer',
        relatedMemoryId: null,
        mandatoryReview: false,
      },
    });
  });

  it('R3 rejected/duplication → quarantine duplicate_content with related id', () => {
    const r = routeDecision(
      d({ verdict: 'rejected', criterion: 'duplication', relatedMemoryId: 'mem-1' }),
      ITEM,
      CFG,
    );
    expect(r.kind).toBe('quarantine');
    if (r.kind !== 'quarantine') return;
    expect(r.reason).toBe('duplicate_content');
    expect(r.redact).toBe(false);
    expect(r.leak).toBe(false);
    expect(r.persist.relatedMemoryId).toBe('mem-1');
    expect(r.persist.criterion).toBe('duplication');
  });

  it('R4 rejected/specificity → quarantine specificity', () => {
    const r = routeDecision(d({ verdict: 'rejected', criterion: 'specificity' }), ITEM, CFG);
    expect(r.kind).toBe('quarantine');
    if (r.kind !== 'quarantine') return;
    expect(r.reason).toBe('specificity');
    expect(r.redact).toBe(false);
    expect(r.persist.relatedMemoryId).toBeNull();
  });

  it.each(['contradiction', 'grounding', 'confidence'] as const)(
    'R5 uncertain/%s → queue uncertain keeping criterion',
    (criterion) => {
      const r = routeDecision(
        d({ verdict: 'uncertain', criterion, confidence: 0.7, relatedMemoryId: 'mem-2' }),
        ITEM,
        CFG,
      );
      expect(r.kind).toBe('queue');
      if (r.kind !== 'queue') return;
      expect(r.queue).toBe('uncertain');
      expect(r.persist).toEqual({
        verdict: 'uncertain',
        criterion,
        confidence: 0.7,
        reason: 'model reason',
        relatedMemoryId: 'mem-2',
        mandatoryReview: false,
      });
    },
  );

  it('R6 accepted below threshold → queue uncertain/confidence', () => {
    const r = routeDecision(d({ confidence: 0.6 }), ITEM, CFG);
    expect(r.kind).toBe('queue');
    if (r.kind !== 'queue') return;
    expect(r.queue).toBe('uncertain');
    expect(r.persist.verdict).toBe('uncertain');
    expect(r.persist.criterion).toBe('confidence');
    expect(r.persist.confidence).toBe(0.6);
  });

  it('R6 null confidence (legacy accepted row) → queued, never applied', () => {
    const r = routeDecision(d({ confidence: null }), ITEM, CFG);
    expect(r.kind).toBe('queue');
  });

  it('R7 accepted ≥ threshold + mandatory type → queue mandatory, persisted accepted + flag', () => {
    const r = routeDecision(d({}), { ...ITEM, type: 'decision' }, CFG);
    expect(r).toEqual({
      kind: 'queue',
      queue: 'mandatory',
      persist: {
        verdict: 'accepted',
        criterion: 'confidence',
        confidence: 0.9,
        reason: 'model reason',
        relatedMemoryId: null,
        mandatoryReview: true,
      },
    });
  });

  it.each(['supersede', 'deprecate'] as const)(
    'R7 %s of a non-mandatory type → mandatory',
    (op) => {
      const r = routeDecision(d({}), { ...ITEM, op }, CFG);
      expect(r.kind).toBe('queue');
      if (r.kind !== 'queue') return;
      expect(r.queue).toBe('mandatory');
    },
  );

  it('R7 sticky persisted mandatory_review → never applied on re-run', () => {
    const r = routeDecision(d({}), { ...ITEM, mandatory_review: true }, CFG);
    expect(r.kind).toBe('queue');
    if (r.kind !== 'queue') return;
    expect(r.queue).toBe('mandatory');
  });

  it('R8 accepted ≥ threshold, not mandatory → apply', () => {
    const r = routeDecision(d({}), ITEM, CFG);
    expect(r).toEqual({
      kind: 'apply',
      persist: {
        verdict: 'accepted',
        criterion: 'confidence',
        confidence: 0.9,
        reason: 'model reason',
        relatedMemoryId: null,
        mandatoryReview: false,
      },
    });
  });

  it('threshold boundary: confidence == threshold → apply (R8) / mandatory (R7)', () => {
    expect(routeDecision(d({ confidence: 0.8 }), ITEM, CFG).kind).toBe('apply');
    const m = routeDecision(d({ confidence: 0.8 }), { ...ITEM, type: 'constraint' }, CFG);
    expect(m.kind === 'queue' && m.queue).toBe('mandatory');
  });

  it('empty mandatory type list → decision accepted above threshold is applied', () => {
    const r = routeDecision(
      d({}),
      { ...ITEM, type: 'decision' },
      { ...CFG, mandatoryReviewTypes: new Set() },
    );
    expect(r.kind).toBe('apply');
  });
});

describe('routeDecision — target type (SEC M-1)', () => {
  it('amend whose target memory type is mandatory → queue mandatory, never applied', () => {
    const r = routeDecision(d({}), { ...ITEM, op: 'amend', target_type: 'decision' }, CFG);
    expect(r.kind === 'queue' && r.queue).toBe('mandatory');
  });

  it('amend whose target type differs from the item type → queue mandatory', () => {
    const r = routeDecision(d({}), { ...ITEM, op: 'amend', target_type: 'gotcha' }, CFG);
    expect(r.kind === 'queue' && r.queue).toBe('mandatory');
  });

  it('amend whose target type matches a non-mandatory item type → apply', () => {
    const r = routeDecision(d({}), { ...ITEM, op: 'amend', target_type: 'pattern' }, CFG);
    expect(r.kind).toBe('apply');
  });

  it('unknown target type (null) falls back to the item type rules', () => {
    const r = routeDecision(d({}), { ...ITEM, op: 'amend', target_type: null }, CFG);
    expect(r.kind).toBe('apply');
  });
});
