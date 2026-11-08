// Judge seam — single source of the judge contract (C1 design, "One judge contract").
// Shared by PromoteService, DeterministicJudge (DEV/TEST) and BedrockJudge (prod).
//
// normalizeJudgeResult is the service-side trust boundary applied to EVERY judge
// result, whatever the implementation: malformed or out-of-table output fails
// closed to the human queue and can never become an auto-accept.

import type { MemoryType } from '../contracts/memory.js';
import { logger } from '../observability/logger.js';

export type Verdict = 'accepted' | 'rejected' | 'uncertain';

export type JudgeCriterion =
  | 'specificity'
  | 'duplication'
  | 'contradiction'
  | 'grounding'
  | 'confidence'
  | 'security_second_layer';

/** Persisted criterion: judge criteria + the service-level stale_target. */
export type DecisionCriterion = JudgeCriterion | 'stale_target';

export interface JudgeItem {
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

/** A similar ACTIVE memory of the same project. title/summary are UNTRUSTED. */
export interface JudgeContextItem {
  /** Memory UUID (server-generated, trusted; never shown to agents). */
  id: string;
  type: MemoryType;
  /** Untrusted. */
  title: string;
  /** Untrusted. */
  summary: string;
}

export interface JudgeResult {
  verdict: Verdict;
  criterion: JudgeCriterion;
  /** In [0, 1]. */
  confidence: number;
  /** At most 500 chars after normalisation. */
  reason: string;
  relatedMemoryId: string | null;
}

export interface Judge {
  evaluate(item: JudgeItem, context: readonly JudgeContextItem[]): Promise<JudgeResult>;
}

/** Allowed (verdict, criterion) pairs — TFG Table 3. */
export const ALLOWED_PAIRS: Record<Verdict, readonly JudgeCriterion[]> = {
  accepted: ['confidence'],
  rejected: ['specificity', 'duplication', 'security_second_layer'],
  uncertain: ['contradiction', 'grounding', 'confidence'],
};

export type FailClosedReason =
  'judge_unavailable' | 'judge_output_invalid' | 'judge_context_unavailable';

/** The fail-closed result: always routed to the human queue, never applied. */
export function failClosed(reason: FailClosedReason): JudgeResult {
  return {
    verdict: 'uncertain',
    criterion: 'confidence',
    confidence: 0,
    reason,
    relatedMemoryId: null,
  };
}

/** Fail-closed reasons that mean "no evaluation at all" (the judge or its context was down). */
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<FailClosedReason>([
  'judge_unavailable',
  'judge_context_unavailable',
]);

/**
 * True when a decision is the fail-closed result of an unavailable judge or
 * judge context (C5 SEC-M2: a human may approve an evaluation, never its
 * absence). Matches on the failClosed shape, so a judge implementation that
 * catches its own errors (BedrockJudge) is covered too.
 */
export function isEvaluationUnavailable(d: { verdict: Verdict; reason: string }): boolean {
  return d.verdict === 'uncertain' && UNAVAILABLE_REASONS.has(d.reason);
}

const MAX_REASON_LENGTH = 500;

/**
 * Validates and normalises a judge result against the given context:
 *  - unknown verdict, pair not in ALLOWED_PAIRS, non-finite or out-of-range
 *    confidence, or non-string reason → failClosed('judge_output_invalid');
 *  - relatedMemoryId not among the context ids → null (warn logs the item id only);
 *  - reason trimmed and truncated to 500 chars.
 *
 * `log.itemId` is used only for the warning; nothing from the result is logged.
 */
export function normalizeJudgeResult(
  r: JudgeResult,
  context: readonly JudgeContextItem[],
  log: { itemId?: string } = {},
): JudgeResult {
  // Object.hasOwn guards against prototype keys (e.g. 'toString') posing as a verdict.
  const allowed = Object.hasOwn(ALLOWED_PAIRS, r.verdict) ? ALLOWED_PAIRS[r.verdict] : undefined;
  if (
    !allowed ||
    !allowed.includes(r.criterion) ||
    typeof r.confidence !== 'number' ||
    !Number.isFinite(r.confidence) ||
    r.confidence < 0 ||
    r.confidence > 1 ||
    typeof r.reason !== 'string'
  ) {
    return failClosed('judge_output_invalid');
  }

  let relatedMemoryId: string | null = null;
  if (r.relatedMemoryId != null) {
    if (context.some((c) => c.id === r.relatedMemoryId)) {
      relatedMemoryId = r.relatedMemoryId;
    } else {
      logger.warn('Judge related memory id not in context — dropped', {
        itemId: log.itemId ?? null,
      });
    }
  }

  return {
    verdict: r.verdict,
    criterion: r.criterion,
    confidence: r.confidence,
    reason: r.reason.trim().slice(0, MAX_REASON_LENGTH),
    relatedMemoryId,
  };
}
