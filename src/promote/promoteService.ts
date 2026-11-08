/**
 * PromoteService — orchestrates the per-session promotion state machine (design C1).
 *
 * Algorithm (sequential; fail-closed; idempotent):
 *   1. fetchPromotableItems (promoted_at IS NULL, reviewed_at IS NULL, project re-assert).
 *      Empty → return no_op immediately.
 *   2. For each item (in order), skipping judge_state === 'rejected' (already terminal):
 *      a. Sanitize (pure, S1–S4): bounds → credentials → embedded instructions → PII mask.
 *         A block quarantines the item (+ leak_detected for credentials). PII is masked
 *         and persisted with its recomputed content_hash BEFORE the judge runs.
 *      b. Decision: a pending item is judged against up to 3 similar active memories
 *         (findJudgeContext) and the result passes through normalizeJudgeResult. A
 *         context failure or a throwing judge fails closed (uncertain/confidence/0) —
 *         never accepted. A non-pending item reuses its persisted decision (no re-judge).
 *      c. routeDecision (pure, R1–R8) → apply | queue | quarantine, then side effects:
 *           queue      → recordDecision + review_enqueued, only when not already queued
 *           quarantine → quarantineItem (+ leak_detected for security_second_layer)
 *           apply      → recordDecision (fresh decisions) → embed (fail-soft) → applyAccepted:
 *                          applied/already → applied; stale → review queue (HU-11.3);
 *                          duplicate → quarantine duplicate_content;
 *                          review_required (target type differs / mandatory) → mandatory queue
 *      An item that throws is logged (id + error name), left pending and not counted.
 *   3. Terminal status: any item failed → partially_promoted; all applied → promoted;
 *      none applied + none queued → rejected; otherwise → partially_promoted. finalizeSession.
 *   4. recordPromote audit. 5. Return PromoteOutcome.
 *
 * Idempotency: the promoted_at IS NULL filter, the rejected skip, the "already
 * queued" check (wasQueued) and applyAccepted's FOR UPDATE + promoted_at guard mean
 * a re-run never re-applies, re-quarantines, re-queues or re-notifies an item.
 * Notifications are sent after the state write, at most once (safeNotify).
 *
 * Single item (C3 restore): promoteItem runs the SAME per-item pipeline (processItem)
 * for one item of a session and finalizes that session; it does not audit — the
 * caller audits as its own actor. The actor never enters the pipeline.
 *
 * Logging: item ids and category names only — never content or judge text.
 */

import type { TenantContext, ActorIdentity, AuditLogger, RequestContext } from '../mcp/context.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
} from '../db/promotionRepository.js';
import type { Judge, JudgeContextItem, JudgeResult } from '../judge/judge.js';
import { failClosed, normalizeJudgeResult } from '../judge/judge.js';
import type { Embedder } from '../embedder/embedder.js';
import { embedItemFailSoft } from '../embedder/embedder.js';
import type { Notifier } from '../notify/notifier.js';
import { safeNotify } from '../notify/notifier.js';
import { computeContentHash } from '../security/hash.js';
import { sanitizeItem, mergeFlags } from './sanitize.js';
import { routeDecision, STALE_TARGET_DECISION } from './routing.js';
import type { RoutingConfig, RoutingDecision } from './routing.js';
import { logger } from '../observability/logger.js';
import { AppError, ErrorCode } from '../errors/appError.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteMeta {
  tenant: TenantContext;
  actor: ActorIdentity;
  originBranch: string;
  originPr: number | null;
  mergeSha: string | null;
}

export interface PromoteOutcome {
  status: 'promoted' | 'rejected' | 'partially_promoted' | 'no_op';
  applied: number;
  deduped: number;
  quarantined: number;
  /** Items left in (or newly placed in) the human review queue. */
  uncertain: number;
}

/** Outcome of one item through the pipeline, with the ids the caller needs. */
export type ItemResult =
  | { outcome: 'applied'; memoryId: string | null; deduped: boolean } // null only on 'already'
  | { outcome: 'queued'; itemId: string }
  | { outcome: 'quarantined'; itemId: string; quarantineId: string | null }
  | { outcome: 'skipped'; itemId: string };

/** Origin metadata for a single-item run (restore): tenant + provenance. */
export interface ItemOrigin {
  tenant: TenantContext;
  originBranch: string;
  originPr: number | null;
}

/** Terminal session status from the counters (a failed item is handled by the caller). */
export function terminalStatus(c: {
  applied: number;
  queued: number;
  total: number;
}): 'promoted' | 'rejected' | 'partially_promoted' {
  if (c.applied === c.total) return 'promoted';
  if (c.applied === 0 && c.queued === 0) return 'rejected';
  return 'partially_promoted';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Narrow seam over PromoteService used by AppServices and test fakes.
 * Mirrors the OidcVerifier / Authorizer seam pattern.
 */
export interface PromoteServiceLike {
  promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome>;
  /**
   * Runs sanitize → judge → route → apply for ONE item and finalizes its session.
   * No audit: the caller audits as its own actor.
   */
  promoteItem(sessionId: string, itemId: string, origin: ItemOrigin): Promise<ItemResult>;
}

export class PromoteService implements PromoteServiceLike {
  constructor(
    private readonly deps: {
      promotionRepository: PromotionRepository;
      judge: Judge;
      auditLogger: AuditLogger;
      embedder: Embedder;
      notifier: Notifier;
      routing: RoutingConfig;
    },
  ) {}

  async promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome> {
    const { promotionRepository, auditLogger } = this.deps;

    // Step 1: pass projectId so the repository JOIN re-asserts tenant ownership.
    const items: PromotionItemRow[] = await promotionRepository.fetchPromotableItems(
      sessionId,
      meta.tenant.projectId,
    );
    if (items.length === 0) {
      return { status: 'no_op', applied: 0, deduped: 0, quarantined: 0, uncertain: 0 };
    }

    const ctx: ApplyContext = {
      projectId: meta.tenant.projectId,
      repoId: meta.tenant.repoId,
      originBranch: meta.originBranch,
      originPr: meta.originPr,
      sessionId,
    };

    let applied = 0;
    let deduped = 0;
    let quarantined = 0;
    let uncertain = 0;
    let errored = 0;

    // Step 2: sequential, per-item transactions (one poisoned item cannot roll back others).
    for (const item of items) {
      let r: ItemResult;
      try {
        r = await this.processItem(item, ctx);
      } catch (err) {
        // The item stays promotable for a re-run; it is not counted. Id + error
        // name only — an error message may echo content.
        errored++;
        logger.error('[promote] item failed — left pending for a re-run', {
          itemId: item.id,
          errorName: errorName(err),
        });
        continue;
      }
      if (r.outcome === 'applied') {
        applied++;
        if (r.deduped) deduped++;
      }
      if (r.outcome === 'quarantined') quarantined++;
      if (r.outcome === 'queued') uncertain++;
    }

    // Step 3: terminal status. A failed item means the session is never fully
    // promoted nor fully rejected.
    const status =
      errored > 0
        ? 'partially_promoted'
        : terminalStatus({ applied, queued: uncertain, total: items.length });
    await promotionRepository.finalizeSession(sessionId, status);

    // Step 4: audit (actorKind 'ci', action 'promote').
    const reqCtx: RequestContext = { tenant: meta.tenant, actor: meta.actor };
    await auditLogger.recordPromote(reqCtx, {
      sessionId,
      applied,
      quarantined,
      uncertain,
      prNumber: meta.originPr,
      mergeSha: meta.mergeSha,
    });

    return { status, applied, deduped, quarantined, uncertain };
  }

  async promoteItem(sessionId: string, itemId: string, origin: ItemOrigin): Promise<ItemResult> {
    const { promotionRepository } = this.deps;
    // projectId re-asserts tenant ownership in the fetch JOIN.
    const items = await promotionRepository.fetchPromotableItems(sessionId, origin.tenant.projectId);
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      // Only reachable through a concurrent abandon/resolution of the session.
      logger.error('[promote] single-item run: item not promotable', { sessionId, itemId });
      throw new AppError(ErrorCode.INTERNAL);
    }

    const ctx: ApplyContext = {
      projectId: origin.tenant.projectId,
      repoId: origin.tenant.repoId,
      originBranch: origin.originBranch,
      originPr: origin.originPr,
      sessionId,
    };
    const r = await this.processItem(item, ctx);
    await promotionRepository.finalizeSession(
      sessionId,
      terminalStatus({
        applied: r.outcome === 'applied' ? 1 : 0,
        queued: r.outcome === 'queued' ? 1 : 0,
        total: 1,
      }),
    );
    return r;
  }

  private async processItem(fetched: PromotionItemRow, ctx: ApplyContext): Promise<ItemResult> {
    const { promotionRepository: repo, notifier } = this.deps;

    // Already quarantined on a prior run — never quarantine twice.
    if (fetched.judge_state === 'rejected') return { outcome: 'skipped', itemId: fetched.id };

    // Already in the review queue: suppresses duplicate writes/notifications on re-runs.
    const wasQueued = fetched.judge_state === 'uncertain' || fetched.mandatory_review;

    // --- Sanitize stage (S1–S4) ---
    const s = sanitizeItem(fetched);
    const flags = mergeFlags(fetched.sanitize_flags, s.flags);

    if (s.block) {
      if (s.block.reason === 'sanitize_failed') {
        logger.warn('[promote] sanitize failed — quarantining (fail-closed)', {
          itemId: fetched.id,
        });
      }
      // S3 snapshot is PII-masked; S1/S2 are redacted by the repository.
      const snapshot = s.masked ? { ...fetched, ...s.masked } : fetched;
      const quarantineId = await repo.quarantineItem(snapshot, ctx, {
        reason: s.block.reason,
        redact: s.block.redact,
        decision: null,
        sanitizeFlags: flags,
      });
      if (s.block.leak) {
        await safeNotify(notifier, ctx.projectId, {
          type: 'leak_detected',
          itemId: fetched.id,
          categories: s.block.categories,
        });
      }
      return { outcome: 'quarantined', itemId: fetched.id, quarantineId };
    }

    let item: PromotionItemRow = fetched;
    if (s.masked) {
      // S4: persist masked content + recomputed hash before the judge sees it.
      const contentHash = computeContentHash({
        op: fetched.op,
        type: fetched.type,
        title: s.masked.title,
        summary: s.masked.summary,
        body: s.masked.body,
        fields: s.masked.fields,
        target: fetched.target_memory_id,
      });
      const masked: PromotionItemRow = {
        ...fetched,
        ...s.masked,
        content_hash: contentHash,
        sanitize_flags: flags,
      };
      const res = await repo.persistMasked(fetched.id, s.masked, contentHash, flags);
      if (res === 'hash_conflict') {
        const quarantineId = await repo.quarantineItem(masked, ctx, {
          reason: 'duplicate_content',
          redact: 'none',
          decision: null,
          sanitizeFlags: flags,
        });
        return { outcome: 'quarantined', itemId: fetched.id, quarantineId };
      }
      item = masked;
    }

    // --- Decision stage ---
    const decision: RoutingDecision =
      item.judge_state === 'pending' ? await this.judgeItem(item, ctx) : fromPersisted(item);

    const route = routeDecision(decision, item, this.deps.routing);

    switch (route.kind) {
      case 'quarantine': {
        const quarantineId = await repo.quarantineItem(item, ctx, {
          reason: route.reason,
          redact: route.redact,
          decision: route.persist,
          sanitizeFlags: route.leak ? mergeFlags(flags, { leak: true }) : flags,
        });
        if (route.leak) {
          await safeNotify(notifier, ctx.projectId, {
            type: 'leak_detected',
            itemId: item.id,
            categories: ['security_second_layer'],
          });
        }
        return { outcome: 'quarantined', itemId: item.id, quarantineId };
      }

      case 'queue': {
        if (!wasQueued) {
          await repo.recordDecision(item.id, route.persist, flags);
          await safeNotify(notifier, ctx.projectId, {
            type: 'review_enqueued',
            itemId: item.id,
            queue: route.queue,
            criterion: route.persist.criterion,
          });
        }
        return { outcome: 'queued', itemId: item.id };
      }

      case 'apply': {
        // Persist a fresh decision before apply, so a crash re-uses it on re-run.
        if (item.judge_state === 'pending') {
          await repo.recordDecision(item.id, route.persist, flags);
        }
        const r = await repo.applyAccepted(
          item,
          ctx,
          await embedItemFailSoft(this.deps.embedder, item),
          this.deps.routing.mandatoryReviewTypes,
        );
        switch (r.status) {
          case 'applied':
            return { outcome: 'applied', memoryId: r.memoryId, deduped: r.deduped };
          case 'already':
            return { outcome: 'applied', memoryId: null, deduped: false };
          case 'review_required':
            // SEC M-1: the target's type differs or is mandatory → human review.
            await repo.recordDecision(item.id, { ...route.persist, mandatoryReview: true }, flags);
            await safeNotify(notifier, ctx.projectId, {
              type: 'review_enqueued',
              itemId: item.id,
              queue: 'mandatory',
              criterion: route.persist.criterion,
            });
            return { outcome: 'queued', itemId: item.id };
          case 'stale':
            // HU-11.3: stale target → human review queue, never quarantine.
            await repo.recordDecision(
              item.id,
              { ...STALE_TARGET_DECISION, confidence: route.persist.confidence },
              flags,
            );
            await safeNotify(notifier, ctx.projectId, {
              type: 'review_enqueued',
              itemId: item.id,
              queue: 'uncertain',
              criterion: 'stale_target',
            });
            return { outcome: 'queued', itemId: item.id };
          case 'duplicate': {
            const quarantineId = await repo.quarantineItem(item, ctx, {
              reason: 'duplicate_content',
              redact: 'none',
              decision: route.persist,
              sanitizeFlags: flags,
            });
            return { outcome: 'quarantined', itemId: item.id, quarantineId };
          }
        }
      }
    }
  }

  /**
   * Judges a pending item against its context. Never throws and never returns an
   * unvalidated result: context failure / judge failure → failClosed (queued).
   */
  private async judgeItem(item: PromotionItemRow, ctx: ApplyContext): Promise<JudgeResult> {
    let context: JudgeContextItem[];
    try {
      context = await this.deps.promotionRepository.findJudgeContext(
        ctx.projectId,
        { title: item.title, summary: item.summary },
        item.target_memory_id,
      );
    } catch (err) {
      logger.warn('[promote] judge context unavailable — failing closed to review', {
        itemId: item.id,
        errorName: errorName(err),
      });
      return failClosed('judge_context_unavailable');
    }

    let result: JudgeResult;
    try {
      result = await this.deps.judge.evaluate(
        {
          op: item.op,
          type: item.type,
          title: item.title,
          summary: item.summary,
          body: item.body,
          fields: item.fields,
        },
        context,
      );
    } catch (err) {
      logger.warn('[promote] judge failed — failing closed to review', {
        itemId: item.id,
        errorName: errorName(err),
      });
      return failClosed('judge_unavailable');
    }

    return normalizeJudgeResult(result, context, { itemId: item.id });
  }
}

/** Rebuilds the decision of a non-pending item from its persisted columns. */
function fromPersisted(item: PromotionItemRow): RoutingDecision {
  return {
    verdict: item.judge_state === 'accepted' ? 'accepted' : 'uncertain',
    criterion: item.judge_criterion ?? 'confidence',
    confidence: item.judge_confidence,
    reason: item.judge_reason ?? '',
    relatedMemoryId: item.related_memory_id,
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}
