/**
 * Judge contract: ALLOWED_PAIRS, failClosed, normalizeJudgeResult.
 *
 * normalizeJudgeResult is the service-side trust boundary for ANY judge
 * implementation: malformed or out-of-table output must never survive as an
 * auto-accept, and a related memory id is only kept if it came from the context.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ALLOWED_PAIRS,
  failClosed,
  isEvaluationUnavailable,
  normalizeJudgeResult,
  type JudgeContextItem,
  type JudgeResult,
} from '../../src/judge/judge.js';
import { logger } from '../../src/observability/logger.js';

const CTX_ID = '0b9f6c1e-3a2d-4c5b-8e7f-1a2b3c4d5e6f';
const FOREIGN_ID = '11111111-2222-4333-8444-555555555555';

const CONTEXT: JudgeContextItem[] = [
  { id: CTX_ID, type: 'decision', title: 'Existing memory', summary: 'Existing summary' },
];

function result(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    verdict: 'accepted',
    criterion: 'confidence',
    confidence: 0.9,
    reason: 'Specific, grounded and novel.',
    relatedMemoryId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ALLOWED_PAIRS — TFG Table 3', () => {
  it('accepted only pairs with confidence', () => {
    expect(ALLOWED_PAIRS.accepted).toEqual(['confidence']);
  });

  it('rejected pairs with specificity, duplication, security_second_layer', () => {
    expect([...ALLOWED_PAIRS.rejected].sort()).toEqual([
      'duplication',
      'security_second_layer',
      'specificity',
    ]);
  });

  it('uncertain pairs with contradiction, grounding, confidence', () => {
    expect([...ALLOWED_PAIRS.uncertain].sort()).toEqual([
      'confidence',
      'contradiction',
      'grounding',
    ]);
  });
});

describe('failClosed', () => {
  it.each(['judge_unavailable', 'judge_output_invalid', 'judge_context_unavailable'] as const)(
    'returns uncertain/confidence/0 with reason %s',
    (reason) => {
      expect(failClosed(reason)).toEqual({
        verdict: 'uncertain',
        criterion: 'confidence',
        confidence: 0,
        reason,
        relatedMemoryId: null,
      });
    },
  );
});

describe('normalizeJudgeResult', () => {
  it('passes a valid result through unchanged', () => {
    const r = result();
    expect(normalizeJudgeResult(r, CONTEXT)).toEqual(r);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.2])(
    'confidence %s → failClosed(judge_output_invalid)',
    (confidence) => {
      expect(normalizeJudgeResult(result({ confidence }), CONTEXT)).toEqual(
        failClosed('judge_output_invalid'),
      );
    },
  );

  it('accepts the boundaries 0 and 1', () => {
    expect(normalizeJudgeResult(result({ confidence: 0 }), CONTEXT).confidence).toBe(0);
    expect(normalizeJudgeResult(result({ confidence: 1 }), CONTEXT).confidence).toBe(1);
  });

  it.each([
    ['accepted', 'specificity'],
    ['accepted', 'duplication'],
    ['rejected', 'contradiction'],
    ['rejected', 'confidence'],
    ['uncertain', 'security_second_layer'],
    ['uncertain', 'duplication'],
  ] as const)('pair %s/%s not in ALLOWED_PAIRS → failClosed', (verdict, criterion) => {
    expect(normalizeJudgeResult(result({ verdict, criterion }), CONTEXT)).toEqual(
      failClosed('judge_output_invalid'),
    );
  });

  it('unknown verdict or criterion strings (runtime garbage) → failClosed', () => {
    const garbage = result({ verdict: 'approve' as never });
    expect(normalizeJudgeResult(garbage, CONTEXT)).toEqual(failClosed('judge_output_invalid'));
    const garbage2 = result({ criterion: 'stale_target' as never });
    expect(normalizeJudgeResult(garbage2, CONTEXT)).toEqual(failClosed('judge_output_invalid'));
  });

  it('keeps a relatedMemoryId that is in the context', () => {
    const r = result({ verdict: 'rejected', criterion: 'duplication', relatedMemoryId: CTX_ID });
    expect(normalizeJudgeResult(r, CONTEXT).relatedMemoryId).toBe(CTX_ID);
  });

  it('drops a relatedMemoryId not in the context and warns with the item id only', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = result({
      verdict: 'rejected',
      criterion: 'duplication',
      reason: 'secret-ish model text',
      relatedMemoryId: FOREIGN_ID,
    });
    const out = normalizeJudgeResult(r, CONTEXT, { itemId: 'item-1' });
    expect(out.relatedMemoryId).toBeNull();
    expect(out.verdict).toBe('rejected');
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('item-1');
    expect(logged).not.toContain(FOREIGN_ID);
    expect(logged).not.toContain('secret-ish');
  });

  it('drops any relatedMemoryId when the context is empty', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = result({ verdict: 'uncertain', criterion: 'contradiction', relatedMemoryId: CTX_ID });
    expect(normalizeJudgeResult(r, []).relatedMemoryId).toBeNull();
  });

  it('trims the reason and truncates it to 500 characters', () => {
    const out = normalizeJudgeResult(result({ reason: `   ${'x'.repeat(800)}   ` }), CONTEXT);
    expect(out.reason).toHaveLength(500);
    expect(normalizeJudgeResult(result({ reason: '  ok  ' }), CONTEXT).reason).toBe('ok');
  });

  it('non-string reason (runtime garbage) → failClosed', () => {
    const r = result({ reason: 42 as never });
    expect(normalizeJudgeResult(r, CONTEXT)).toEqual(failClosed('judge_output_invalid'));
  });
});

describe('isEvaluationUnavailable (C5 SEC-M2)', () => {
  it('judge or context down → true', () => {
    expect(isEvaluationUnavailable(failClosed('judge_unavailable'))).toBe(true);
    expect(isEvaluationUnavailable(failClosed('judge_context_unavailable'))).toBe(true);
  });

  it('invalid output, a real uncertain verdict or an accepted one → false', () => {
    expect(isEvaluationUnavailable(failClosed('judge_output_invalid'))).toBe(false);
    expect(isEvaluationUnavailable(result({ verdict: 'uncertain', criterion: 'grounding' }))).toBe(
      false,
    );
    expect(isEvaluationUnavailable(result({ reason: 'judge_unavailable' }))).toBe(false);
  });
});
