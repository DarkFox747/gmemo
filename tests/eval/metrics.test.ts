/**
 * Pure retrieval and judge metrics used by `pnpm eval` (C8, TT-06).
 */

import { describe, it, expect } from 'vitest';
import {
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  judgeErrorRates,
  mean,
} from '../../scripts/lib/metrics.js';

describe('recallAtK', () => {
  it('is the share of relevant ids found in the top k', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], { a: 1, d: 2, z: 1 }, 2)).toBeCloseTo(1 / 3);
    expect(recallAtK(['a', 'b', 'c', 'd'], { a: 1, d: 2, z: 1 }, 4)).toBeCloseTo(2 / 3);
  });

  it('ignores ids with zero gain', () => {
    expect(recallAtK(['a'], { a: 0, b: 1 }, 5)).toBe(0);
  });

  it('rejects a query without relevant ids and a non-positive k', () => {
    expect(() => recallAtK(['a'], {}, 5)).toThrow(RangeError);
    expect(() => recallAtK(['a'], { a: 1 }, 0)).toThrow(RangeError);
  });
});

describe('reciprocalRank', () => {
  it('is 1 / rank of the first relevant id', () => {
    expect(reciprocalRank(['x', 'y', 'a'], { a: 1 })).toBeCloseTo(1 / 3);
    expect(reciprocalRank(['a', 'b'], { b: 2, a: 1 })).toBe(1);
  });

  it('is 0 when nothing relevant is returned', () => {
    expect(reciprocalRank(['x', 'y'], { a: 1 })).toBe(0);
    expect(reciprocalRank([], { a: 1 })).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('is 1 for the ideal ordering', () => {
    expect(ndcgAtK(['a', 'b', 'c'], { a: 2, b: 1 }, 5)).toBeCloseTo(1);
  });

  it('uses graded gains (2^rel - 1) with a log2 discount', () => {
    // DCG = (2^1-1)/log2(2) + (2^2-1)/log2(3); IDCG = 3/log2(2) + 1/log2(3)
    const dcg = 1 + 3 / Math.log2(3);
    const idcg = 3 + 1 / Math.log2(3);
    expect(ndcgAtK(['b', 'a'], { a: 2, b: 1 }, 5)).toBeCloseTo(dcg / idcg);
  });

  it('only counts the top k, and is 0 without hits', () => {
    expect(ndcgAtK(['x', 'a'], { a: 1 }, 1)).toBe(0);
    expect(ndcgAtK(['x', 'y'], { a: 1 }, 5)).toBe(0);
  });
});

describe('judgeErrorRates', () => {
  it('FP = good units held back / good units; FN = bad units let through / bad units', () => {
    const r = judgeErrorRates([
      { label: 'good', flagged: false },
      { label: 'good', flagged: true },
      { label: 'good', flagged: false },
      { label: 'good', flagged: false },
      { label: 'bad', flagged: true },
      { label: 'bad', flagged: false },
    ]);
    expect(r).toEqual({
      good: 4,
      bad: 2,
      falsePositives: 1,
      falseNegatives: 1,
      falsePositiveRate: 0.25,
      falseNegativeRate: 0.5,
    });
  });

  it('requires at least one case of each label', () => {
    expect(() => judgeErrorRates([{ label: 'good', flagged: false }])).toThrow(RangeError);
  });
});

describe('mean', () => {
  it('averages, and rejects an empty list', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(() => mean([])).toThrow(RangeError);
  });
});
