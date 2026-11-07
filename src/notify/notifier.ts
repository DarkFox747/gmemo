/**
 * Notifier seam — best-effort notifications for the human review queue and
 * credential leaks. Payloads carry ids, queue kind, criterion and category
 * names ONLY; never a title, summary, body, field value, matched text or
 * judge reason.
 */

import type { DecisionCriterion } from '../judge/judge.js';
import { logger } from '../observability/logger.js';

export type NotifyEvent =
  | {
      type: 'review_enqueued';
      itemId: string;
      queue: 'uncertain' | 'mandatory';
      criterion: DecisionCriterion;
    }
  | { type: 'leak_detected'; itemId: string; categories: string[] };

export interface Notifier {
  notify(projectId: string, event: NotifyEvent): Promise<void>;
}

/** Structured-log implementation; SES (or similar) can replace it later. */
export const logNotifier: Notifier = {
  notify(projectId: string, event: NotifyEvent): Promise<void> {
    if (event.type === 'leak_detected') {
      logger.warn('notify', { projectId, ...event });
    } else {
      logger.info('notify', { projectId, ...event });
    }
    return Promise.resolve();
  },
};

/** Calls the notifier; a failure is logged (ids only) and never thrown. */
export async function safeNotify(n: Notifier, projectId: string, e: NotifyEvent): Promise<void> {
  try {
    await n.notify(projectId, e);
  } catch (err) {
    logger.error('notify failed', {
      event: e.type,
      projectId,
      itemId: e.itemId,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}
