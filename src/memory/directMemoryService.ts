/**
 * DirectMemoryService (C5, HU-13): the project_admin browses project memory,
 * previews a unit against the pipeline and judge, and confirms an add or amend.
 *
 * No second write path. A confirm becomes a one-item staging session
 * (`web/<userId>/<sessionId>`, author = the actor) processed by the SAME
 * single-item pipeline as promotions (PromoteService.promoteItem) in
 * human-approved mode: the confirm replaces the review queue, never the
 * sanitize quarantine, judge rejections or apply-time duplicates.
 *
 * Every outcome closes the session: promoteItem finalizes terminal outcomes;
 * a conflict, an unavailable evaluation, an unexpected outcome or a throw
 * abandons it here. A process crash between the session insert and that close
 * leaves an open `web/%` session: the `web-session-reaper` job abandons it
 * (and deletes its non-promoted item) after 5 minutes (SEC-M1).
 *
 * Fail-closed judge (SEC-M2): when the judge or its context is unavailable,
 * promoteItem returns 'unavailable' without writing; the session is abandoned
 * and the route answers 503 evaluation_unavailable. The preview reports the
 * same case as outcome 'unavailable'.
 *
 * Dedup onto a non-active memory (SEC-L4): an add whose content hash equals a
 * deprecated/superseded/pending memory dedups onto that row without changing
 * it, so it is reported as 409 duplicate_inactive, never as "applied". (Chosen
 * over filtering the dedup to active rows: the UNIQUE(project_id, content_hash)
 * constraint covers every status, so such an insert could never succeed.)
 *
 * Committed write, then 500 (CR-M4): once promoteItem has applied the item, the
 * memory row and its revision are COMMITTED. If re-reading the memory for the
 * response fails (throw, or the row vanished), the caller gets a 500 although the
 * write (and its audit row, committed in the same transaction — C11) stands (the
 * abandon is a no-op on the finalized session). An audit insert failure rolls the
 * write back instead: nothing is committed and the session is abandoned. The client must re-read (GET the list or the
 * detail) before retrying; a retry of the same add dedups (deduped: true), and a
 * retry of an amend gets 409 target_changed. Both are logged with ids only.
 *
 * Preview runs evaluateCandidate (reads only) and writes nothing; it never
 * notifies (a leak is notified only on confirm).
 *
 * Shared pre-checks (preview, create, amend), before anything is written:
 *   1. repo: body repoId within the project, else the project's first repo → not_found
 *   2. amend target: missing/foreign → not_found; not active → target_inactive;
 *      revision ≠ expectedRevision → target_changed; type change → invalid
 *
 * The route binds the audit row (actor, action); writeAudit maps the committed
 * write to its detail and the repository inserts it before COMMIT. Logging:
 * ids only — never content.
 */

import type { AdminActor, ApiAuditDetail, ApiWriteAudit } from '../mcp/context.js';
import type { ItemWrite } from '../db/promotionRepository.js';
import type { TxnAudit } from '../db/authRepository.js';
import type {
  MemoryDetailDto,
  MemoryListDto,
  MemoryListItemDto,
  MemoryListQueryInput,
  PreviewResponseDto,
} from '../http/api/types.js';
import type {
  MemoryDetailRow,
  MemoryListRow,
  MemoryRevisionRow,
} from '../db/memoryAdminRepository.js';
import type { InsertStagingItemParams } from '../db/stagingRepository.js';
import type { ItemResult } from '../promote/promoteService.js';
import { evaluateCandidate } from '../promote/evaluate.js';
import { isEvaluationUnavailable } from '../judge/judge.js';
import type { CandidateEvaluation, CandidateContent } from '../promote/evaluate.js';
import type { RouteOutcome } from '../promote/routing.js';
import { classifyQuarantine } from '../quarantine/reason.js';
import { isSecretFree } from '../security/secretRedact.js';
import { computeContentHash } from '../security/hash.js';
import { toMemoryRefDto } from '../review/reviewService.js';
import { ulid } from '../db/ulid.js';
import { AppError, ErrorCode } from '../errors/appError.js';
import { logger } from '../observability/logger.js';
import type {
  AmendInput,
  DirectMemoryServiceDeps,
  DirectMemoryServiceLike,
  PreviewInput,
  PreviewOutcome,
  UnitInput,
  WriteOutcome,
} from './types.js';

export type { DirectMemoryServiceLike } from './types.js';

type PreCheck =
  | { kind: 'ok'; repoId: string; target: MemoryDetailRow | null }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: 'target_changed' | 'target_inactive' }
  | { kind: 'invalid' };

interface TargetRef {
  memoryId: string;
  expectedRevision: number;
}

function toListItemDto(r: MemoryListRow): MemoryListItemDto {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    status: r.status,
    version: r.current_revision,
    provenance: r.provenance,
    originBranch: r.origin_branch,
    originPr: r.origin_pr,
    revalidateAt: r.revalidate_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

function toDetailDto(
  r: MemoryDetailRow,
  revisions: { rows: MemoryRevisionRow[]; truncated: boolean },
): MemoryDetailDto {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    body: r.body,
    fields: r.fields,
    status: r.status,
    version: r.current_revision,
    provenance: r.provenance,
    author: r.author,
    // SEC-L3: the approver's display name only, never its app_user id.
    approver: r.approved_by ? { name: r.approver } : null,
    repo: r.repo_id ? { id: r.repo_id, slug: r.repo_slug } : null,
    originBranch: r.origin_branch,
    originPr: r.origin_pr,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    revalidateAt: r.revalidate_at?.toISOString() ?? null,
    retiredReason: r.retired_reason,
    revisions: revisions.rows.map((v) => ({
      revisionNo: v.revision_no,
      op: v.op,
      type: v.type,
      title: v.title,
      summary: v.summary,
      body: v.body,
      fields: v.fields,
      author: v.author,
      createdAt: v.created_at.toISOString(),
    })),
    revisionsTruncated: revisions.truncated,
  };
}

function withoutApproval(route: RouteOutcome): PreviewResponseDto['withoutApproval'] {
  if (route.kind === 'apply') return 'apply';
  if (route.kind === 'quarantine') return 'quarantine';
  return route.queue === 'mandatory' ? 'queue_mandatory' : 'queue_uncertain';
}

/** Content shown to the tech lead only when provably secret-free (C3 gate). */
function safePreview(content: CandidateContent | null): CandidateContent | null {
  return content !== null && isSecretFree(content) ? content : null;
}

function findings(ev: CandidateEvaluation): PreviewResponseDto['pipeline']['findings'] {
  const { secrets, injection, pii } = ev.sanitize.flags;
  const out: PreviewResponseDto['pipeline']['findings'] = {};
  if (secrets) out.secrets = secrets;
  if (injection) out.injection = injection;
  if (pii) out.pii = pii;
  return out;
}

/**
 * Maps the committed terminal write to the route's audit detail (same detail as
 * before C11). A dedup onto a non-active memory is not audited: the route
 * answers 409 duplicate_inactive (nothing in memory changed). A queue decision
 * is not a direct-write outcome: refusing it rolls the write back and the
 * caller abandons the session (fail closed).
 */
function writeAudit(
  audit: ApiWriteAudit,
  itemId: string,
  target: TargetRef | null,
): TxnAudit<ItemWrite> {
  return async (db, w) => {
    if (w.outcome === 'applied') {
      if (w.deduped && w.memoryStatus !== 'active') return;
      const detail: ApiAuditDetail = {
        memoryId: w.memoryId,
        itemId,
        outcome: 'applied',
        deduped: w.deduped,
      };
      await audit(db, detail);
      return;
    }
    if (w.outcome === 'quarantined') {
      const detail: ApiAuditDetail = {
        itemId,
        outcome: 'quarantined',
        quarantineId: w.quarantineId,
      };
      if (target) detail.memoryId = target.memoryId;
      await audit(db, detail);
      return;
    }
    logger.error('[direct] queue decision refused for a direct write', { itemId });
    throw new AppError(ErrorCode.INTERNAL);
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

export class DirectMemoryService implements DirectMemoryServiceLike {
  constructor(private readonly deps: DirectMemoryServiceDeps) {}

  async list(projectId: string, q: MemoryListQueryInput): Promise<MemoryListDto> {
    const { rows, nextCursor } = await this.deps.memoryAdminRepository.listMemories(projectId, q);
    return { items: rows.map(toListItemDto), nextCursor, truncated: nextCursor !== null };
  }

  async get(projectId: string, memoryId: string): Promise<MemoryDetailDto | null> {
    const repo = this.deps.memoryAdminRepository;
    const row = await repo.findMemory(projectId, memoryId);
    if (!row) return null;
    return toDetailDto(row, await repo.listRevisions(projectId, memoryId));
  }

  async preview(
    _actor: AdminActor,
    projectId: string,
    input: PreviewInput,
  ): Promise<PreviewOutcome> {
    const target: TargetRef | null =
      input.op === 'amend'
        ? { memoryId: input.targetMemoryId, expectedRevision: input.expectedRevision }
        : null;
    const pre = await this.preCheck(projectId, input, target);
    if (pre.kind !== 'ok') return pre;

    const ev = await evaluateCandidate(
      {
        op: input.op,
        type: input.type,
        title: input.title,
        summary: input.summary,
        body: input.body,
        fields: input.fields,
        target_memory_id: target?.memoryId ?? null,
        target_type: pre.target?.type ?? null,
        mandatory_review: false,
      },
      {
        contextSource: this.deps.promotionRepository,
        judge: this.deps.judge,
        routing: this.deps.routing,
      },
      { projectId, persisted: null, logId: 'preview' },
    );

    const dto = await this.toPreviewDto(projectId, input, ev);
    const audit: ApiAuditDetail = { type: input.type, previewOutcome: dto.outcome };
    if (target) audit.memoryId = target.memoryId;
    return { kind: 'ok', dto, audit };
  }

  create(
    actor: AdminActor,
    projectId: string,
    input: UnitInput,
    audit: ApiWriteAudit,
  ): Promise<WriteOutcome> {
    return this.write(actor, projectId, input, null, audit);
  }

  amend(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    input: AmendInput,
    audit: ApiWriteAudit,
  ): Promise<WriteOutcome> {
    return this.write(
      actor,
      projectId,
      input,
      { memoryId, expectedRevision: input.expectedRevision },
      audit,
    );
  }

  // -------------------------------------------------------------------------

  private async preCheck(
    projectId: string,
    unit: UnitInput,
    target: TargetRef | null,
  ): Promise<PreCheck> {
    const repo = this.deps.memoryAdminRepository;
    const repoId = await repo.findProjectRepoId(projectId, unit.repoId);
    if (repoId === null) return { kind: 'not_found' };
    if (!target) return { kind: 'ok', repoId, target: null };

    const t = await repo.findMemory(projectId, target.memoryId);
    if (!t) return { kind: 'not_found' };
    if (t.status !== 'active') return { kind: 'conflict', code: 'target_inactive' };
    if (t.current_revision !== target.expectedRevision) {
      return { kind: 'conflict', code: 'target_changed' };
    }
    // SEC M-1 (as remember): an op may not change its target's type.
    if (t.type !== unit.type) return { kind: 'invalid' };
    return { kind: 'ok', repoId, target: t };
  }

  private async toPreviewDto(
    projectId: string,
    input: UnitInput,
    ev: CandidateEvaluation,
  ): Promise<PreviewResponseDto> {
    const given: CandidateContent = {
      title: input.title,
      summary: input.summary,
      body: input.body,
      fields: input.fields,
    };

    if (ev.kind === 'blocked') {
      const { block, masked } = ev.sanitize;
      return {
        outcome: 'quarantine',
        withoutApproval: 'quarantine',
        pipeline: { blocked: true, reasonCode: block.reason, findings: findings(ev) },
        // S1 (sanitize_failed) never shows content.
        preview: block.reason === 'sanitize_failed' ? null : safePreview(masked ?? given),
        judge: null,
        quarantineReasonCode: classifyQuarantine(block.reason, null).reasonCode,
      };
    }

    const { decision, route } = ev;
    // SEC-M2: a confirm of this unit would be refused (503), so say so.
    const unavailable = isEvaluationUnavailable(decision);
    let related = null;
    if (decision.relatedMemoryId) {
      const refs = await this.deps.reviewQueueRepository.findMemoryRefs(projectId, [
        decision.relatedMemoryId,
      ]);
      related = refs[0] ? toMemoryRefDto(refs[0]) : null;
    }
    const quarantine = route.kind === 'quarantine';
    return {
      outcome: unavailable ? 'unavailable' : quarantine ? 'quarantine' : 'apply',
      withoutApproval: withoutApproval(route),
      pipeline: { blocked: false, reasonCode: null, findings: findings(ev) },
      preview: safePreview(ev.content),
      judge: {
        verdict: decision.verdict,
        criterion: decision.criterion,
        confidence: decision.confidence,
        threshold: this.deps.routing.confidenceThreshold,
        // C1 R2: the model text of a security rejection is never surfaced.
        reason:
          decision.criterion === 'security_second_layer'
            ? 'security_second_layer'
            : decision.reason,
        related,
      },
      quarantineReasonCode: quarantine
        ? classifyQuarantine(route.reason, route.persist.criterion).reasonCode
        : null,
    };
  }

  private async write(
    actor: AdminActor,
    projectId: string,
    unit: UnitInput,
    target: TargetRef | null,
    audit: ApiWriteAudit,
  ): Promise<WriteOutcome> {
    const pre = await this.preCheck(projectId, unit, target);
    if (pre.kind !== 'ok') return pre;

    const op = target ? 'amend' : 'add';
    const item: InsertStagingItemParams = {
      op,
      type: unit.type,
      title: unit.title,
      summary: unit.summary,
      body: unit.body,
      fields: unit.fields,
      contentHash: computeContentHash({
        op,
        type: unit.type,
        title: unit.title,
        summary: unit.summary,
        body: unit.body,
        fields: unit.fields,
        target: target?.memoryId ?? null,
      }),
      targetMemoryId: target?.memoryId ?? null,
      targetRevision: target?.expectedRevision ?? null,
      judgeState: 'pending',
      authorIdentity: actor.actorId,
      judgeCriterion: null,
      mandatoryReview: false,
      judgeReason: null,
    };
    const sessionId = ulid();
    const branch = `web/${actor.userId}/${sessionId}`;
    const { itemId } = await this.deps.stagingRepository.createSingleItemSession({
      sessionId,
      projectId,
      repoId: pre.repoId,
      branch,
      openedBy: actor.actorId,
      item,
    });

    let r: ItemResult;
    try {
      r = await this.deps.promoteService.promoteItem(
        sessionId,
        itemId,
        { tenant: { projectId, repoId: pre.repoId, branch }, originBranch: branch, originPr: null },
        {
          humanApproved: { approverUserId: actor.userId },
          audit: writeAudit(audit, itemId, target),
        },
      );
    } catch (err) {
      logger.error('[direct] pipeline failed', { sessionId, itemId, errorName: errorName(err) });
      await this.abandon(sessionId, projectId, itemId).catch(() => {
        // Already logged by abandon(); the pipeline error is the one surfaced.
      });
      throw err;
    }

    const ids = { sessionId, itemId };
    switch (r.outcome) {
      case 'applied': {
        if (r.memoryId === null) break;
        const memory = await this.get(projectId, r.memoryId);
        if (!memory) break;
        // SEC-L4: an add whose content equals a deprecated/superseded/pending
        // memory dedups onto that row without changing it — never report it as
        // applied (the content is NOT live). The session and item stay promoted
        // (they point at the existing row); nothing in memory was written.
        if (r.deduped && memory.status !== 'active') {
          logger.info('[direct] add deduplicated onto a non-active memory', {
            ...ids,
            memoryId: r.memoryId,
          });
          return { kind: 'conflict', code: 'duplicate_inactive' };
        }
        return { kind: 'done', dto: { outcome: 'applied', deduped: r.deduped, memory } };
      }
      case 'quarantined': {
        if (r.quarantineId === null) break;
        const q = await this.deps.quarantineRepository.findVisible(
          projectId,
          { isAdmin: true, subject: actor.actorId },
          r.quarantineId,
        );
        return {
          kind: 'done',
          dto: {
            outcome: 'quarantined',
            quarantineId: r.quarantineId,
            reasonCode: q?.reasonCode ?? null,
            criterion: q?.criterion ?? null,
          },
        };
      }
      case 'conflict':
        await this.abandon(sessionId, projectId, itemId);
        return { kind: 'conflict', code: r.code };
      case 'unavailable':
        // SEC-M2: nothing was written; close the session and refuse (503).
        await this.abandon(sessionId, projectId, itemId);
        return { kind: 'unavailable' };
      default:
        break;
    }

    // queued / skipped / an applied or quarantined result without its id.
    logger.error('[direct] unexpected pipeline outcome', { ...ids, outcome: r.outcome });
    await this.abandon(sessionId, projectId, itemId);
    throw new AppError(ErrorCode.INTERNAL);
  }

  /** Abandons the web session (deletes its non-promoted item). Logs and rethrows on failure. */
  private async abandon(sessionId: string, projectId: string, itemId: string): Promise<void> {
    try {
      await this.deps.promotionRepository.abandonOpenSession(sessionId, projectId);
    } catch (err) {
      logger.error('[direct] session abandon failed', {
        sessionId,
        itemId,
        errorName: errorName(err),
      });
      throw err;
    }
  }
}
