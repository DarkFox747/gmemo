/**
 * Shared classifier fixture table (C3). Drives BOTH tests/quarantine/reason.test.ts
 * (classifyQuarantine) and the 0008 backfill test, so code and SQL cannot drift.
 */

import type { DecisionCriterion } from '../../src/judge/judge.js';
import type { QuarantineCriterion, QuarantineReasonCode } from '../../src/quarantine/reason.js';

export interface ReasonFixture {
  name: string;
  reason: string;
  /** Decision criterion of the origin item (null = none / item swept). */
  decisionCriterion: DecisionCriterion | null;
  criterion: QuarantineCriterion;
  reasonCode: QuarantineReasonCode;
}

export const REASON_FIXTURES: readonly ReasonFixture[] = [
  {
    name: 'S2 secret',
    reason: 'secret_detected',
    decisionCriterion: null,
    criterion: 'pipeline',
    reasonCode: 'secret_detected',
  },
  {
    name: 'S3 injection',
    reason: 'embedded_instructions',
    decisionCriterion: null,
    criterion: 'pipeline',
    reasonCode: 'embedded_instructions',
  },
  {
    name: 'S1 sanitize failed',
    reason: 'sanitize_failed',
    decisionCriterion: null,
    criterion: 'pipeline',
    reasonCode: 'sanitize_failed',
  },
  {
    name: 'R3 duplicate (judge duplication)',
    reason: 'duplicate_content',
    decisionCriterion: 'duplication',
    criterion: 'judge',
    reasonCode: 'duplicate_content',
  },
  {
    name: 'S4/A3 duplicate (no decision)',
    reason: 'duplicate_content',
    decisionCriterion: null,
    criterion: 'pipeline',
    reasonCode: 'duplicate_content',
  },
  {
    name: 'A3 duplicate after accepted',
    reason: 'duplicate_content',
    decisionCriterion: 'confidence',
    criterion: 'pipeline',
    reasonCode: 'duplicate_content',
  },
  {
    name: 'R2 second layer',
    reason: 'security_second_layer',
    decisionCriterion: 'security_second_layer',
    criterion: 'judge',
    reasonCode: 'secret_detected',
  },
  {
    name: 'R4 specificity',
    reason: 'specificity',
    decisionCriterion: 'specificity',
    criterion: 'judge',
    reasonCode: 'judge_rejected',
  },
  {
    name: 'legacy judge_rejected',
    reason: 'judge_rejected',
    decisionCriterion: null,
    criterion: 'judge',
    reasonCode: 'judge_rejected',
  },
  {
    name: 'unknown reason',
    reason: 'stale_target',
    decisionCriterion: null,
    criterion: 'judge',
    reasonCode: 'judge_rejected',
  },
  {
    name: 'human reject',
    reason: 'human_review: too vague',
    decisionCriterion: null,
    criterion: 'human_review',
    reasonCode: 'human_rejected',
  },
  {
    name: 'human reject (no space)',
    reason: 'human_review:x',
    decisionCriterion: null,
    criterion: 'human_review',
    reasonCode: 'human_rejected',
  },
  {
    name: 'LIKE-wildcard lookalike',
    reason: 'humanXreview: x',
    decisionCriterion: null,
    criterion: 'judge',
    reasonCode: 'judge_rejected',
  },
];
