/**
 * Quarantine classification (C3, HU-10) — pure, no I/O.
 *
 * classifyQuarantine is the single source of the judge_reason → (criterion,
 * reason_code) mapping. Migration 0008 mirrors it in SQL for the backfill, and
 * both are tested against the same fixture table so they cannot drift.
 *
 * The fine-grained reason (e.g. `specificity`) stays in quarantine.judge_reason.
 */

import type { DecisionCriterion } from '../judge/judge.js';
import { REDACTED_TOKEN } from '../security/secretRedact.js';

export const QUARANTINE_CRITERIA = ['pipeline', 'judge', 'human_review'] as const;
export const QUARANTINE_REASON_CODES = [
  'secret_detected',
  'embedded_instructions',
  'duplicate_content',
  'judge_rejected',
  'human_rejected',
  'sanitize_failed',
] as const;

export type QuarantineCriterion = (typeof QUARANTINE_CRITERIA)[number];
export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

/** How the snapshot content is stored. */
export type QuarantineRedaction = 'none' | 'spans' | 'whole';

/** Prefix of judge_reason for a human rejection from the review queue (C2). */
export const HUMAN_REVIEW_PREFIX = 'human_review: ';

/** Sanitize-stage reasons (S1–S3): the pipeline blocked the item before the judge. */
const PIPELINE_REASONS: ReadonlySet<string> = new Set([
  'secret_detected',
  'embedded_instructions',
  'sanitize_failed',
]);

export function classifyQuarantine(
  reason: string,
  decisionCriterion: DecisionCriterion | null,
): { criterion: QuarantineCriterion; reasonCode: QuarantineReasonCode } {
  // Matches SQL starts_with(judge_reason, 'human_review:') — the space is not required.
  if (reason.startsWith('human_review:')) {
    return { criterion: 'human_review', reasonCode: 'human_rejected' };
  }
  if (PIPELINE_REASONS.has(reason)) {
    return { criterion: 'pipeline', reasonCode: reason as QuarantineReasonCode };
  }
  if (reason === 'duplicate_content') {
    // R3 (judge duplication) vs S4 hash conflict / A3 memory-hash collision.
    return {
      criterion: decisionCriterion === 'duplication' ? 'judge' : 'pipeline',
      reasonCode: 'duplicate_content',
    };
  }
  if (reason === 'security_second_layer') {
    return { criterion: 'judge', reasonCode: 'secret_detected' };
  }
  // specificity, legacy judge_rejected, anything else.
  return { criterion: 'judge', reasonCode: 'judge_rejected' };
}

/**
 * SEC-L3: rows whose stored content is a redaction (credentials, fail-closed
 * sanitize) cannot be restored: re-running the pipeline on `[REDACTADO]` can
 * never recover the original item. The restore claim SQL applies the same rule
 * with these values as bind parameters.
 */
export const NON_RESTORABLE_REASON_CODES: readonly QuarantineReasonCode[] = [
  'secret_detected',
  'sanitize_failed',
];

export function isRestorable(row: {
  reasonCode: QuarantineReasonCode | null;
  title: string;
  summary: string;
  body: string;
}): boolean {
  if (row.reasonCode !== null && NON_RESTORABLE_REASON_CODES.includes(row.reasonCode)) {
    return false;
  }
  return ![row.title, row.summary, row.body].includes(REDACTED_TOKEN);
}
