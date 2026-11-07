/**
 * ⚠️  DEV/TEST-ONLY JUDGE STUB — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DeterministicJudge returns a fixed Verdict for every item regardless of
 * content. It is chosen at the composition root ONLY when JUDGE_STUB=true AND
 * NODE_ENV !== 'production'. config.loadConfig() fails fast if that pairing
 * is ever attempted in production, so this class can never run there.
 *
 * // DEV-ONLY
 */
import type { Judge, JudgeItem, Verdict } from './judge.js';

export class DeterministicJudge implements Judge {
  constructor(private readonly verdict: Verdict) {}

  async evaluate(_item: JudgeItem): Promise<Verdict> {
    return this.verdict;
  }
}
