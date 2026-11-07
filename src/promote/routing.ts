/**
 * Decision stage of the promotion pipeline (design C1, R1–R8). Pure: maps a
 * normalised (or persisted) decision to one outcome; PromoteService performs
 * the persistence and notification side effects. First matching row wins:
 *
 *   R1 criterion stale_target                → queue uncertain (mandatory)
 *   R2 rejected / security_second_layer      → quarantine, redact, leak
 *   R3 rejected / duplication                → quarantine duplicate_content (+ related id)
 *   R4 rejected / specificity                → quarantine specificity
 *   R5 uncertain / any                       → queue uncertain
 *   R6 accepted, confidence < threshold|null → queue uncertain / confidence
 *   R7 accepted ≥ threshold, mandatory       → queue mandatory (NOT applied; item type,
 *                                              op, sticky flag or known target type)
 *   R8 accepted ≥ threshold, not mandatory   → apply
 *
 * Anything outside the table (e.g. a rejected verdict with an unexpected
 * criterion) fails closed to the review queue — never to apply.
 */

import type { MemoryType } from '../contracts/memory.js';
import type { DecisionCriterion, Verdict } from '../judge/judge.js';
import type { PersistedDecision, PromotionItemRow } from '../db/promotionRepository.js';

export interface RoutingConfig {
  confidenceThreshold: number;
  mandatoryReviewTypes: ReadonlySet<MemoryType>;
}

export type QuarantineReason =
  | 'secret_detected'
  | 'embedded_instructions'
  | 'sanitize_failed'
  | 'duplicate_content'
  | 'specificity'
  | 'security_second_layer';

export type RouteOutcome =
  | { kind: 'apply'; persist: PersistedDecision }
  | { kind: 'queue'; queue: 'uncertain' | 'mandatory'; persist: PersistedDecision }
  | {
      kind: 'quarantine';
      reason: QuarantineReason;
      redact: boolean;
      leak: boolean;
      persist: PersistedDecision;
    };

/** Decision input: a normalised JudgeResult or one rebuilt from persisted columns. */
export interface RoutingDecision {
  verdict: Verdict;
  criterion: DecisionCriterion;
  confidence: number | null;
  reason: string;
  relatedMemoryId: string | null;
}

export type RoutingItem = Pick<PromotionItemRow, 'op' | 'type' | 'mandatory_review'> & {
  /** Type of the target memory (non-add ops), when known; null/absent otherwise. */
  target_type?: MemoryType | null;
};

export const STALE_TARGET_REASON = 'target revision is no longer current';

/** HU-11.3: a stale target always goes to human review, never to quarantine. */
export const STALE_TARGET_DECISION: Omit<PersistedDecision, 'confidence'> = {
  verdict: 'uncertain',
  criterion: 'stale_target',
  reason: STALE_TARGET_REASON,
  relatedMemoryId: null,
  mandatoryReview: true,
};

/**
 * The persisted flag is sticky, so a re-run never applies a queued item. A known
 * target type counts too: a mandatory target, or an item whose type differs from
 * its target, can never be auto-applied (SEC M-1).
 */
function isMandatory(item: RoutingItem, cfg: RoutingConfig): boolean {
  const target = item.target_type ?? null;
  return (
    item.mandatory_review ||
    cfg.mandatoryReviewTypes.has(item.type) ||
    item.op === 'supersede' ||
    item.op === 'deprecate' ||
    (target !== null && (target !== item.type || cfg.mandatoryReviewTypes.has(target)))
  );
}

export function routeDecision(
  d: RoutingDecision,
  item: RoutingItem,
  cfg: RoutingConfig,
): RouteOutcome {
  // R1
  if (d.criterion === 'stale_target') {
    return {
      kind: 'queue',
      queue: 'uncertain',
      persist: { ...STALE_TARGET_DECISION, confidence: null },
    };
  }

  if (d.verdict === 'rejected') {
    const base = { verdict: 'rejected' as const, confidence: d.confidence, mandatoryReview: false };
    switch (d.criterion) {
      case 'security_second_layer': // R2 — the model text is never stored.
        return {
          kind: 'quarantine',
          reason: 'security_second_layer',
          redact: true,
          leak: true,
          persist: {
            ...base,
            criterion: 'security_second_layer',
            reason: 'security_second_layer',
            relatedMemoryId: null,
          },
        };
      case 'duplication': // R3
        return {
          kind: 'quarantine',
          reason: 'duplicate_content',
          redact: false,
          leak: false,
          persist: {
            ...base,
            criterion: 'duplication',
            reason: d.reason,
            relatedMemoryId: d.relatedMemoryId,
          },
        };
      case 'specificity': // R4
        return {
          kind: 'quarantine',
          reason: 'specificity',
          redact: false,
          leak: false,
          persist: { ...base, criterion: 'specificity', reason: d.reason, relatedMemoryId: null },
        };
      default:
        // Outside the table: fail closed to the human queue.
        return queueUncertain({ ...d, criterion: 'confidence', relatedMemoryId: null }, item);
    }
  }

  // R5
  if (d.verdict === 'uncertain') {
    return queueUncertain(d, item);
  }

  // R6 — a null confidence (legacy row) counts as below the threshold.
  if (d.confidence === null || d.confidence < cfg.confidenceThreshold) {
    return queueUncertain({ ...d, criterion: 'confidence', relatedMemoryId: null }, item);
  }

  const acceptedPersist = (mandatoryReview: boolean): PersistedDecision => ({
    verdict: 'accepted',
    criterion: 'confidence',
    confidence: d.confidence,
    reason: d.reason,
    relatedMemoryId: null,
    mandatoryReview,
  });

  // R7
  if (isMandatory(item, cfg)) {
    return { kind: 'queue', queue: 'mandatory', persist: acceptedPersist(true) };
  }

  // R8
  return { kind: 'apply', persist: acceptedPersist(false) };
}

function queueUncertain(d: RoutingDecision, item: RoutingItem): RouteOutcome {
  return {
    kind: 'queue',
    queue: 'uncertain',
    persist: {
      verdict: 'uncertain',
      criterion: d.criterion,
      confidence: d.confidence,
      reason: d.reason,
      relatedMemoryId: d.relatedMemoryId,
      mandatoryReview: item.mandatory_review,
    },
  };
}
