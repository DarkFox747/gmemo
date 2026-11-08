import { describe, it, expect } from 'vitest';
import {
  classifyQuarantine,
  HUMAN_REVIEW_PREFIX,
  QUARANTINE_CRITERIA,
  QUARANTINE_REASON_CODES,
} from '../../src/quarantine/reason.js';
import { REASON_FIXTURES } from './reasonFixtures.js';

describe('classifyQuarantine', () => {
  it.each(REASON_FIXTURES)('$name → $criterion / $reasonCode', (f) => {
    expect(classifyQuarantine(f.reason, f.decisionCriterion)).toEqual({
      criterion: f.criterion,
      reasonCode: f.reasonCode,
    });
  });

  it('classifies the C2 reject prefix as human_review', () => {
    expect(classifyQuarantine(`${HUMAN_REVIEW_PREFIX}nope`, null).criterion).toBe('human_review');
  });

  it('exposes the closed enum value sets of migration 0008', () => {
    expect(QUARANTINE_CRITERIA).toEqual(['pipeline', 'judge', 'human_review']);
    expect(QUARANTINE_REASON_CODES).toEqual([
      'secret_detected',
      'embedded_instructions',
      'duplicate_content',
      'judge_rejected',
      'human_rejected',
      'sanitize_failed',
    ]);
  });
});
