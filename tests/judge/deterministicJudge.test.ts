/**
 * T017 (part 1): DeterministicJudge unit tests.
 *
 * Verifies that each of the three valid Verdict values ('accepted', 'rejected',
 * 'uncertain') is returned verbatim for any JudgeItem when the judge is
 * constructed with that verdict.
 *
 * DeterministicJudge is a DEV/TEST-only stub; it ignores item content entirely
 * and returns the value fixed at construction time.
 */

import { describe, it, expect } from 'vitest';
import { DeterministicJudge } from '../../src/judge/deterministicJudge.js';
import type { JudgeItem } from '../../src/judge/judge.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

/** Minimal JudgeItem — content is irrelevant; DeterministicJudge ignores it. */
const STUB_ITEM: JudgeItem = {
  op: 'add',
  type: 'decision',
  title: 'Use read-replicas for FTS queries',
  summary: 'Route all recall queries to a read-replica to offload primary.',
  body: 'Primary write traffic is high. Read-replicas allow independent scaling.',
  fields: {},
};

// ---------------------------------------------------------------------------
// One suite per verdict value
// ---------------------------------------------------------------------------

describe("DeterministicJudge configured with 'accepted'", () => {
  const judge = new DeterministicJudge('accepted');

  it("resolves 'accepted' for a standard item", async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('accepted');
  });

  it('never throws', async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.not.toThrow();
  });
});

describe("DeterministicJudge configured with 'rejected'", () => {
  const judge = new DeterministicJudge('rejected');

  it("resolves 'rejected' for a standard item", async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('rejected');
  });

  it('never throws', async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.not.toThrow();
  });
});

describe("DeterministicJudge configured with 'uncertain'", () => {
  const judge = new DeterministicJudge('uncertain');

  it("resolves 'uncertain' for a standard item", async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  it('never throws', async () => {
    await expect(judge.evaluate(STUB_ITEM)).resolves.not.toThrow();
  });
});

describe('DeterministicJudge — verdict is independent of item content', () => {
  it("returns the configured verdict regardless of item op field", async () => {
    const judge = new DeterministicJudge('accepted');
    const ops = ['add', 'amend', 'supersede', 'deprecate'] as const;

    for (const op of ops) {
      await expect(judge.evaluate({ ...STUB_ITEM, op })).resolves.toBe('accepted');
    }
  });

  it("returns the configured verdict regardless of item type field", async () => {
    const judge = new DeterministicJudge('rejected');
    const types = [
      'decision',
      'constraint',
      'gotcha',
      'pattern',
      'integration_note',
      'domain_rule',
      'outcome',
    ] as const;

    for (const type of types) {
      await expect(judge.evaluate({ ...STUB_ITEM, type })).resolves.toBe('rejected');
    }
  });
});
