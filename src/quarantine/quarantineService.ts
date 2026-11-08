/**
 * QuarantineService (C3, HU-10): list / detail / restore for the REST routes.
 *
 * Visibility comes from the project member: project_admin sees every row of
 * the project; any other member only rows they authored (author_identity =
 * principal.subject). Restore is admin-only — the route enforces it before
 * calling restore().
 *
 * Restore = atomic claim (session `restore/<id>`, pending item with the original
 * author, restored_* label) → the SAME per-item pipeline as a promotion
 * (PromoteService.promoteItem) → applied | queued | quarantined. The restorer
 * never enters the pipeline. The route binds the audit row (as the restorer);
 * the item's terminal write commits it in its own transaction (C11). The claim
 * is its own earlier transaction: when the pipeline fails after it (a throw,
 * an audit failure that rolled the terminal write back, or an outcome restore
 * cannot produce) the claim is released — the `restore/<id>` session is
 * abandoned and the restored_* label cleared, so the row is back in the list
 * and a retry can claim it. No audit row is written (nothing was restored).
 *
 * Logging: ids only — never content.
 */

import type { ApiAuditDetail, ApiWriteAudit, ProjectMember } from '../mcp/context.js';
import type {
  QuarantineDetailDto,
  QuarantineItemDto,
  QuarantineListDto,
  RestoreResponseDto,
} from '../http/api/types.js';
import type {
  QuarantineDetailRow,
  QuarantineListRow,
  QuarantineRepository,
  QuarantineViewer,
} from '../db/quarantineRepository.js';
import type { PromoteServiceLike } from '../promote/promoteService.js';
import type { QuarantineReasonCode } from './reason.js';
import { isRestorable } from './reason.js';
import { AppError, ErrorCode } from '../errors/appError.js';
import { logger } from '../observability/logger.js';

export interface QuarantineQueryInput {
  reason: QuarantineReasonCode | null;
  limit: number;
}

export type RestoreOutcome = { kind: 'restored'; dto: RestoreResponseDto } | { kind: 'not_found' };

/** Surface consumed by the quarantine routes. */
export interface QuarantineServiceLike {
  list(
    member: ProjectMember,
    projectId: string,
    q: QuarantineQueryInput,
  ): Promise<QuarantineListDto>;
  get(member: ProjectMember, projectId: string, id: string): Promise<QuarantineDetailDto | null>;
  /**
   * Caller must have checked member.projectRole === 'project_admin'. `audit`
   * rides on the restored item's terminal write (C11).
   */
  restore(
    member: ProjectMember,
    projectId: string,
    id: string,
    audit: ApiWriteAudit,
  ): Promise<RestoreOutcome>;
}

function viewerOf(member: ProjectMember): QuarantineViewer {
  return { isAdmin: member.projectRole === 'project_admin', subject: member.actorId };
}

function toItemDto(r: QuarantineListRow): QuarantineItemDto {
  return {
    id: r.id,
    reasonCode: r.reasonCode,
    criterion: r.criterion,
    op: r.op,
    type: r.type,
    title: r.title,
    excerpt: r.excerpt,
    quarantinedAt: r.quarantinedAt.toISOString(),
    daysUntilExpiry: r.daysUntilExpiry,
  };
}

/**
 * judgeReason (the judge's free-text justification) is admin-only (SEC-L5);
 * authors see reasonCode/criterion. canRestore = admin AND restorable (SEC-L3).
 */
function toDetailDto(r: QuarantineDetailRow, isAdmin: boolean): QuarantineDetailDto {
  const dto: QuarantineDetailDto = {
    ...toItemDto(r),
    summary: r.summary,
    body: r.body,
    fields: r.fields,
    author: r.author,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    originBranch: r.originBranch,
    originPr: r.originPr,
    related: r.related ? { ...r.related, updatedAt: r.related.updatedAt.toISOString() } : null,
    canRestore: isAdmin && isRestorable(r),
  };
  if (isAdmin) dto.judgeReason = r.judgeReason;
  return dto;
}

export class QuarantineService implements QuarantineServiceLike {
  constructor(
    private readonly deps: {
      quarantineRepository: QuarantineRepository;
      promoteService: Pick<PromoteServiceLike, 'promoteItem'>;
    },
  ) {}

  async list(
    member: ProjectMember,
    projectId: string,
    q: QuarantineQueryInput,
  ): Promise<QuarantineListDto> {
    const { rows, truncated } = await this.deps.quarantineRepository.list(
      projectId,
      viewerOf(member),
      q,
    );
    return { items: rows.map(toItemDto), truncated };
  }

  async get(
    member: ProjectMember,
    projectId: string,
    id: string,
  ): Promise<QuarantineDetailDto | null> {
    const viewer = viewerOf(member);
    const row = await this.deps.quarantineRepository.findVisible(projectId, viewer, id);
    return row ? toDetailDto(row, viewer.isAdmin) : null;
  }

  async restore(
    member: ProjectMember,
    projectId: string,
    id: string,
    audit: ApiWriteAudit,
  ): Promise<RestoreOutcome> {
    const claim = await this.deps.quarantineRepository.claimForRestore({
      projectId,
      quarantineId: id,
      restoredByUserId: member.userId,
      openedBy: member.actorId,
    });
    if (claim.status === 'not_found') return { kind: 'not_found' };

    const base: ApiAuditDetail = { quarantineId: id, itemId: claim.itemId };
    let result;
    try {
      result = await this.deps.promoteService.promoteItem(
        claim.sessionId,
        claim.itemId,
        {
          tenant: { projectId, repoId: claim.repoId, branch: claim.branch },
          originBranch: claim.branch,
          originPr: claim.originPr,
        },
        {
          audit: (db, w) => {
            if (w.outcome === 'applied') {
              return audit(db, { ...base, outcome: 'applied', memoryId: w.memoryId });
            }
            if (w.outcome === 'quarantined') {
              return audit(db, {
                ...base,
                outcome: 'quarantined',
                newQuarantineId: w.quarantineId,
              });
            }
            return audit(db, { ...base, outcome: 'queued' });
          },
        },
      );
    } catch (err) {
      logger.error('[quarantine] restore pipeline failed after claim', {
        quarantineId: id,
        itemId: claim.itemId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      await this.releaseClaim(projectId, id, claim);
      throw err;
    }

    switch (result.outcome) {
      case 'applied': {
        const dto: RestoreResponseDto = { outcome: 'applied' };
        if (result.memoryId) dto.memoryId = result.memoryId;
        return { kind: 'restored', dto };
      }
      case 'queued':
        return { kind: 'restored', dto: { outcome: 'queued', itemId: result.itemId } };
      case 'quarantined': {
        const dto: RestoreResponseDto = { outcome: 'quarantined' };
        if (result.quarantineId) dto.quarantineId = result.quarantineId;
        return { kind: 'restored', dto };
      }
      case 'conflict':
        // Human-approved mode only (C5): restore never passes the option.
        logger.error('[quarantine] restore produced a human-approval conflict', {
          quarantineId: id,
          itemId: claim.itemId,
        });
        await this.releaseClaim(projectId, id, claim);
        throw new AppError(ErrorCode.INTERNAL);
      default:
        // 'skipped' is impossible for a freshly claimed pending item.
        logger.error('[quarantine] restore produced an unexpected outcome', {
          quarantineId: id,
          itemId: claim.itemId,
          outcome: result.outcome,
        });
        await this.releaseClaim(projectId, id, claim);
        throw new AppError(ErrorCode.INTERNAL);
    }
  }

  /**
   * Un-claims a failed restore (backlog E4 #1). The caller rethrows its own
   * error, so a release failure is logged (name only) rather than masking it;
   * the row then stays claimed, as before C11.
   */
  private async releaseClaim(
    projectId: string,
    quarantineId: string,
    claim: { sessionId: string; itemId: string },
  ): Promise<void> {
    try {
      const released = await this.deps.quarantineRepository.releaseRestoreClaim({
        projectId,
        quarantineId,
        sessionId: claim.sessionId,
        itemId: claim.itemId,
      });
      if (!released) {
        logger.warn('[quarantine] restore claim not released (item already written)', {
          quarantineId,
          itemId: claim.itemId,
        });
      }
    } catch (err) {
      logger.error('[quarantine] restore claim release failed', {
        quarantineId,
        itemId: claim.itemId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}
