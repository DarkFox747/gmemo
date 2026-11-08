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
 * for one item of a session and finalizes that session. The caller's audit row
 * (its own actor) is written by the item's terminal write, in that write's
 * transaction (opts.audit, C11). The actor never enters the pipeline.
 *
 * Human-approved mode (C5, project_admin direct writes ONLY): promoteItem with
 * opts.humanApproved replaces review queueing (R5–R7) with apply — provenance
 * 'web_ui', approved_by = the approver, no mandatory-type block (the type-change
 * guard stays) — and turns a stale apply into { outcome: 'conflict' } (session
 * left open for the caller to abandon). A judge or context that failed closed is
 * never approved: { outcome: 'unavailable' }, nothing written, session left open
 * (SEC-M2). Sanitize quarantine (S1–S3), PII mask,
 * judge rejections (R2–R4) and apply-time duplicates (A3) are unchanged.
 * promote() never enables it.
 *
 * Evaluation (sanitize → judge → route) is the shared, write-free
 * evaluateCandidate; masked content is persisted after it, before any state write.
 *
 * Logging: item ids and category names only — never content or judge text.
 */

import type { TenantContext, ActorIdentity, AuditLogger, RequestContext } from '../mcp/context.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
  ItemWrite,
} from '../db/promotionRepository.js';
import type { TxnAudit } from '../db/authRepository.js';
import { NO_MANDATORY_TYPES } from '../db/promotionRepository.js';
import type { Judge } from '../judge/judge.js';
import { isEvaluationUnavailable } from '../judge/judge.js';
import type { Embedder } from '../embedder/embedder.js';
import { embedItemFailSoft } from '../embedder/embedder.js';
import type { Notifier } from '../notify/notifier.js';
import { safeNotify } from '../notify/notifier.js';
import { computeContentHash } from '../security/hash.js';
import { mergeFlags } from './sanitize.js';
import { STALE_TARGET_DECISION } from './routing.js';
import type { RoutingConfig, RoutingDecision } from './routing.js';
import { evaluateCandidate } from './evaluate.js';
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
  | { outcome: 'skipped'; itemId: string }
  /**
   * humanApproved ONLY: the target moved between the caller's check and apply.
   * Nothing written; the session is left open for the caller to abandon.
   */
  | { outcome: 'conflict'; itemId: string; code: 'target_changed' }
  /**
   * humanApproved ONLY (SEC-M2): the judge or its context failed closed, so
   * there is no evaluation to approve. Nothing written; the session is left
   * open for the caller to abandon.
   */
  | { outcome: 'unavailable'; itemId: string };

/** The project_admin who confirmed a direct web write: app_user.id (AdminActor.userId). */
export interface HumanApproval {
  approverUserId: string;
}

export interface PromoteItemOptions {
  /** C5 direct management only (never MCP, /promote or restore). */
  humanApproved?: HumanApproval;
  /**
   * C11 (restore, direct management): the caller's access_log row, written by
   * the item's terminal write (apply, quarantine or queue decision) in that
   * write's own transaction. Outcomes that write nothing never run it.
   */
  audit?: TxnAudit<ItemWrite>;
}

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
   * Runs sanitize → judge → route → apply for ONE item and finalizes its session
   * (except on 'conflict', humanApproved only). The caller's audit (as its own
   * actor) rides on the terminal write via opts.audit (C11).
   */
  promoteItem(
    sessionId: string,
    itemId: string,
    origin: ItemOrigin,
    opts?: PromoteItemOptions,
  ): Promise<ItemResult>;
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
      provenance: 'pr_reviewed',
      approvedBy: null,
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
        r = await this.processItem(item, ctx, false);
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

  async promoteItem(
    sessionId: string,
    itemId: string,
    origin: ItemOrigin,
    opts: PromoteItemOptions = {},
  ): Promise<ItemResult> {
    const { promotionRepository } = this.deps;
    // projectId re-asserts tenant ownership in the fetch JOIN.
    const items = await promotionRepository.fetchPromotableItems(
      sessionId,
      origin.tenant.projectId,
    );
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
      provenance: opts.humanApproved ? 'web_ui' : 'pr_reviewed',
      approvedBy: opts.humanApproved?.approverUserId ?? null,
    };
    const r = await this.processItem(item, ctx, opts.humanApproved !== undefined, opts.audit);
    // A conflict or an unavailable evaluation leaves the session open: the (only) caller abandons it.
    if (r.outcome === 'conflict' || r.outcome === 'unavailable') return r;
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

  private async processItem(
    fetched: PromotionItemRow,
    ctx: ApplyContext,
    humanApproved: boolean,
    audit?: TxnAudit<ItemWrite>,
  ): Promise<ItemResult> {
    const { promotionRepository: repo, notifier } = this.deps;

    // Already quarantined on a prior run — never quarantine twice.
    if (fetched.judge_state === 'rejected') return { outcome: 'skipped', itemId: fetched.id };

    // Already in the review queue: suppresses duplicate writes/notifications on re-runs.
    const wasQueued = fetched.judge_state === 'uncertain' || fetched.mandatory_review;

    // --- Evaluation: sanitize (S1–S4) → judge → route (no writes) ---
    const ev = await evaluateCandidate(
      fetched,
      { contextSource: repo, judge: this.deps.judge, routing: this.deps.routing },
      {
        projectId: ctx.projectId,
        persisted: fetched.judge_state === 'pending' ? null : fromPersisted(fetched),
        logId: fetched.id,
      },
    );
    const flags = mergeFlags(fetched.sanitize_flags, ev.sanitize.flags);

    if (ev.kind === 'blocked') {
      const { block, masked } = ev.sanitize;
      if (block.reason === 'sanitize_failed') {
        logger.warn('[promote] sanitize failed — quarantining (fail-closed)', {
          itemId: fetched.id,
        });
      }
      // S3 snapshot is PII-masked; S1/S2 are redacted by the repository.
      const snapshot = masked ? { ...fetched, ...masked } : fetched;
      const quarantineId = await repo.quarantineItem(
        snapshot,
        ctx,
        {
          reason: block.reason,
          redact: block.redact,
          decision: null,
          sanitizeFlags: flags,
        },
        audit,
      );
      if (block.leak) {
        await safeNotify(notifier, ctx.projectId, {
          type: 'leak_detected',
          itemId: fetched.id,
          categories: block.categories,
        });
      }
      return { outcome: 'quarantined', itemId: fetched.id, quarantineId };
    }

    // SEC-M2: a human approves an evaluation, never its absence. When the judge
    // or its context failed closed, nothing is written (not even the masked
    // content) and the caller refuses the confirm.
    if (humanApproved && isEvaluationUnavailable(ev.decision)) {
      logger.warn('[promote] human-approved item not applied: evaluation unavailable', {
        itemId: fetched.id,
        reason: ev.decision.reason,
      });
      return { outcome: 'unavailable', itemId: fetched.id };
    }

    let item: PromotionItemRow = fetched;
    const masked = ev.sanitize.masked;
    if (masked) {
      // S4: persist masked content + recomputed hash before any state write.
      const contentHash = computeContentHash({
        op: fetched.op,
        type: fetched.type,
        title: masked.title,
        summary: masked.summary,
        body: masked.body,
        fields: masked.fields,
        target: fetched.target_memory_id,
      });
      const maskedItem: PromotionItemRow = {
        ...fetched,
        ...masked,
        content_hash: contentHash,
        sanitize_flags: flags,
      };
      const res = await repo.persistMasked(fetched.id, masked, contentHash, flags);
      if (res === 'hash_conflict') {
        const quarantineId = await repo.quarantineItem(
          maskedItem,
          ctx,
          { reason: 'duplicate_content', redact: 'none', decision: null, sanitizeFlags: flags },
          audit,
        );
        return { outcome: 'quarantined', itemId: fetched.id, quarantineId };
      }
      item = maskedItem;
    }

    let route = ev.route;
    // Human approval (C5): the project_admin's confirm IS the review, so R5–R7
    // apply. Nothing is recorded first: a 'pending' item is never in the review
    // queue predicate, so a crash can never surface a direct write there.
    // R1 (stale_target) and a rejected verdict outside the table (both impossible
    // for a freshly judged item) are never overridden: they stay queued.
    const humanApply =
      humanApproved &&
      route.kind === 'queue' &&
      route.persist.criterion !== 'stale_target' &&
      ev.decision.verdict !== 'rejected';
    if (humanApply) {
      route = { kind: 'apply', persist: { ...route.persist, mandatoryReview: false } };
    }

    switch (route.kind) {
      case 'quarantine': {
        const quarantineId = await repo.quarantineItem(
          item,
          ctx,
          {
            reason: route.reason,
            redact: route.redact,
            decision: route.persist,
            sanitizeFlags: route.leak ? mergeFlags(flags, { leak: true }) : flags,
          },
          audit,
        );
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
          await repo.recordDecision(item.id, route.persist, flags, audit);
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
        if (item.judge_state === 'pending' && !humanApply) {
          await repo.recordDecision(item.id, route.persist, flags);
        }
        const r = await repo.applyAccepted(
          item,
          ctx,
          await embedItemFailSoft(this.deps.embedder, item),
          // A mandatory target type is exactly what the human approval covers.
          humanApproved ? NO_MANDATORY_TYPES : this.deps.routing.mandatoryReviewTypes,
          audit,
        );
        switch (r.status) {
          case 'applied':
            return { outcome: 'applied', memoryId: r.memoryId, deduped: r.deduped };
          case 'already':
            return { outcome: 'applied', memoryId: null, deduped: false };
          case 'review_required':
            if (humanApproved) {
              // Only a type change can reach this (the caller refuses it first).
              logger.warn('[promote] human-approved apply refused by the type guard', {
                itemId: item.id,
              });
              return { outcome: 'conflict', itemId: item.id, code: 'target_changed' };
            }
            // SEC M-1: the target's type differs or is mandatory → human review.
            await repo.recordDecision(
              item.id,
              { ...route.persist, mandatoryReview: true },
              flags,
              audit,
            );
            await safeNotify(notifier, ctx.projectId, {
              type: 'review_enqueued',
              itemId: item.id,
              queue: 'mandatory',
              criterion: route.persist.criterion,
            });
            return { outcome: 'queued', itemId: item.id };
          case 'stale':
            // Human approval: the target moved after the caller's check → 409, nothing written.
            if (humanApproved) {
              return { outcome: 'conflict', itemId: item.id, code: 'target_changed' };
            }
            // HU-11.3: stale target → human review queue, never quarantine.
            await repo.recordDecision(
              item.id,
              { ...STALE_TARGET_DECISION, confidence: route.persist.confidence },
              flags,
              audit,
            );
            await safeNotify(notifier, ctx.projectId, {
              type: 'review_enqueued',
              itemId: item.id,
              queue: 'uncertain',
              criterion: 'stale_target',
            });
            return { outcome: 'queued', itemId: item.id };
          case 'duplicate': {
            const quarantineId = await repo.quarantineItem(
              item,
              ctx,
              {
                reason: 'duplicate_content',
                redact: 'none',
                decision: route.persist,
                sanitizeFlags: flags,
              },
              audit,
            );
            return { outcome: 'quarantined', itemId: item.id, quarantineId };
          }
        }
      }
    }
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
