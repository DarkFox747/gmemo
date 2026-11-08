/**
 * ReviewService — orchestrates and maps the human review queue (HU-07).
 *
 * Pure orchestration over two repositories (read side: ReviewQueueRepository,
 * write side: PromotionRepository's transactional approve/reject) so it is
 * unit-testable with fakes. Routes own the audit. No notifier events: resolving
 * an item is the human's own, audited action.
 *
 * Logging: item ids only — never content or reason text.
 */

import type { AdminActor, ApiAuditDetail } from '../mcp/context.js';
import type { PromotionRepository } from '../db/promotionRepository.js';
import type {
  MemoryRefRow,
  ReviewItemRow,
  ReviewQueueRepository,
  ReviewQueueRow,
} from '../db/reviewQueueRepository.js';
import type { Embedder } from '../embedder/embedder.js';
import { embedItemFailSoft } from '../embedder/embedder.js';
import { scanForSecrets } from '../security/secretScan.js';
import { normalizeForScan } from '../security/normalizeForScan.js';
import { maskPii } from '../security/piiMask.js';
import { logger } from '../observability/logger.js';
import type {
  ApproveInput,
  ApproveOutcome,
  MemoryRefDto,
  RejectInput,
  RejectOutcome,
  QueueQueryInput,
  ReviewItemDetailDto,
  ReviewQueueItemDto,
  ReviewQueueListDto,
  ReviewServiceLike,
} from '../http/api/types.js';

export type { ApproveOutcome, RejectOutcome, ReviewServiceLike } from '../http/api/types.js';

export interface ReviewServiceDeps {
  reviewQueueRepository: ReviewQueueRepository;
  promotionRepository: Pick<PromotionRepository, 'approveReviewItem' | 'rejectReviewItem'>;
  embedder: Embedder;
  /** config.JUDGE_CONFIDENCE_THRESHOLD */
  confidenceThreshold: number;
}

export class ReviewService implements ReviewServiceLike {
  constructor(private readonly deps: ReviewServiceDeps) {}

  async list(projectId: string, q: QueueQueryInput): Promise<ReviewQueueListDto> {
    const { reviewQueueRepository: repo } = this.deps;
    const [{ rows, truncated }, counters] = await Promise.all([
      repo.listQueue(projectId, { filter: q.filter, type: q.type ?? null, limit: q.limit }),
      repo.countQueue(projectId),
    ]);
    return { items: rows.map(toQueueItemDto), counters, truncated };
  }

  async get(projectId: string, itemId: string): Promise<ReviewItemDetailDto | null> {
    const { reviewQueueRepository: repo } = this.deps;
    const item = await repo.findQueuedItem(projectId, itemId);
    if (!item) return null;

    const ids = [item.related_memory_id, item.target_memory_id].filter(
      (id): id is string => id !== null,
    );
    const refs = await repo.findMemoryRefs(projectId, ids);
    const byId = new Map(refs.map((r) => [r.id, r]));
    const targetRow = item.target_memory_id ? (byId.get(item.target_memory_id) ?? null) : null;
    const relatedRow = item.related_memory_id ? (byId.get(item.related_memory_id) ?? null) : null;

    const targetStale =
      item.op !== 'add' &&
      (targetRow === null ||
        targetRow.status !== 'active' ||
        targetRow.current_revision !== item.target_revision);

    return {
      ...toQueueItemDto(item),
      summary: item.summary,
      body: item.body,
      fields: item.fields,
      reason: item.judge_reason,
      threshold: this.deps.confidenceThreshold,
      sanitizeFlags: item.sanitize_flags,
      targetRevision: item.target_revision,
      target: targetRow ? toMemoryRefDto(targetRow) : null,
      related: relatedRow ? toMemoryRefDto(relatedRow) : null,
      targetStale,
    };
  }

  async approve(
    actor: AdminActor,
    projectId: string,
    itemId: string,
    b: ApproveInput,
  ): Promise<ApproveOutcome> {
    const { reviewQueueRepository, promotionRepository, embedder } = this.deps;

    const item = await reviewQueueRepository.findQueuedItem(projectId, itemId);
    if (!item) return { kind: 'not_found' };

    const embedding = await embedItemFailSoft(embedder, item);

    const r = await promotionRepository.approveReviewItem({
      projectId,
      itemId,
      reviewerUserId: actor.userId,
      expectedContentHash: item.content_hash,
      embedding,
      targetRevision: b.targetRevision ?? null,
      markRelatedSuperseded: b.markRelatedSuperseded,
    });

    if (r.status === 'not_found') return { kind: 'not_found' };
    if (r.status === 'conflict') return { kind: 'conflict', code: r.code };

    const audit: ApiAuditDetail = {
      itemId,
      memoryId: r.memoryId,
      decision: 'approved',
      deduped: r.deduped,
      relatedSuperseded: r.relatedSuperseded,
    };
    if (r.rebasedFromRevision !== null && r.rebasedToRevision !== null) {
      audit.rebasedFromRevision = r.rebasedFromRevision;
      audit.rebasedToRevision = r.rebasedToRevision;
    }
    return {
      kind: 'approved',
      dto: {
        itemId,
        decision: 'approved',
        memoryId: r.memoryId,
        deduped: r.deduped,
        rebasedFromRevision: r.rebasedFromRevision,
        relatedSuperseded: r.relatedSuperseded,
      },
      audit,
    };
  }

  async reject(
    actor: AdminActor,
    projectId: string,
    itemId: string,
    b: RejectInput,
  ): Promise<RejectOutcome> {
    // Never echoed, never stored: a secret in the reason is an invalid request.
    if (scanForSecrets(normalizeForScan(b.reason)).length > 0) {
      logger.warn('[review] reject reason rejected: secret detected', { itemId });
      return { kind: 'invalid_reason' };
    }

    let reason: string;
    try {
      reason = maskPii(b.reason).text;
    } catch (err) {
      // Fail closed: an unmaskable reason is never stored.
      logger.warn('[review] reject reason could not be PII-masked', {
        itemId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      return { kind: 'invalid_reason' };
    }

    const res = await this.deps.promotionRepository.rejectReviewItem({
      projectId,
      itemId,
      reviewerUserId: actor.userId,
      reason,
    });
    if (res === 'not_found') return { kind: 'not_found' };
    return { kind: 'rejected', dto: { itemId, decision: 'rejected' } };
  }
}

function toQueueItemDto(r: ReviewQueueRow | ReviewItemRow): ReviewQueueItemDto {
  return {
    id: r.id,
    op: r.op,
    type: r.type,
    title: r.title,
    judgeState: r.judge_state,
    criterion: r.judge_criterion,
    confidence: r.judge_confidence,
    mandatoryReview: r.mandatory_review,
    originBranch: r.origin_branch,
    originPr: r.origin_pr,
    author: r.author,
    createdAt: r.created_at.toISOString(),
  };
}

function toMemoryRefDto(r: MemoryRefRow): MemoryRefDto {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    status: r.status,
    version: r.current_revision,
    originBranch: r.origin_branch,
    originPr: r.origin_pr,
    updatedAt: r.updated_at.toISOString(),
  };
}
