/**
 * Retrieval and judge metrics for `pnpm eval` (C8, TT-06). Pure functions, no I/O.
 *
 * Relevance is graded: `relevance[id]` is the gain of a unit for a query
 * (0 = not relevant, 1 = partially, 2 = fully). A unit is "relevant" when its
 * gain is > 0. `ranked` is the result list, best first.
 */

export type Relevance = Readonly<Record<string, number>>;

function relevantIds(relevance: Relevance): string[] {
  return Object.keys(relevance).filter((id) => (relevance[id] ?? 0) > 0);
}

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
}

/** Share of the relevant units that appear in the top k. */
export function recallAtK(ranked: readonly string[], relevance: Relevance, k: number): number {
  assertK(k);
  const relevant = relevantIds(relevance);
  if (relevant.length === 0) throw new RangeError('query has no relevant units');
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

/** 1 / rank of the first relevant unit; 0 when none is returned. */
export function reciprocalRank(ranked: readonly string[], relevance: Relevance): number {
  const index = ranked.findIndex((id) => (relevance[id] ?? 0) > 0);
  return index === -1 ? 0 : 1 / (index + 1);
}

function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, rel, i) => sum + (2 ** rel - 1) / Math.log2(i + 2), 0);
}

/** Normalised discounted cumulative gain over the top k (graded gains). */
export function ndcgAtK(ranked: readonly string[], relevance: Relevance, k: number): number {
  assertK(k);
  const ideal = Object.values(relevance)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = dcg(ideal);
  if (idcg === 0) return 0;
  return dcg(ranked.slice(0, k).map((id) => relevance[id] ?? 0)) / idcg;
}

export interface JudgeCase {
  /** Ground truth: should this unit reach memory (good) or not (bad)? */
  label: 'good' | 'bad';
  /** The judge held it back (rejected, uncertain or below the confidence threshold). */
  flagged: boolean;
}

export interface JudgeErrorRates {
  good: number;
  bad: number;
  falsePositives: number;
  falseNegatives: number;
  /** Good units held back / good units. */
  falsePositiveRate: number;
  /** Bad units let through / bad units. */
  falseNegativeRate: number;
}

export function judgeErrorRates(cases: readonly JudgeCase[]): JudgeErrorRates {
  const good = cases.filter((c) => c.label === 'good');
  const bad = cases.filter((c) => c.label === 'bad');
  if (good.length === 0 || bad.length === 0) {
    throw new RangeError('need at least one good and one bad case');
  }
  const falsePositives = good.filter((c) => c.flagged).length;
  const falseNegatives = bad.filter((c) => !c.flagged).length;
  return {
    good: good.length,
    bad: bad.length,
    falsePositives,
    falseNegatives,
    falsePositiveRate: falsePositives / good.length,
    falseNegativeRate: falseNegatives / bad.length,
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean of an empty list');
  return values.reduce((a, b) => a + b, 0) / values.length;
}
