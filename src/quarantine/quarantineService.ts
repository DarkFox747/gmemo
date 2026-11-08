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
 * never enters the pipeline; the route audits as the restorer.
 *
 * Logging: ids only — never content.
 */

import type { ApiAuditDetail, ProjectMember } from '../mcp/context.js';
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

export type RestoreOutcome =
  { kind: 'restored'; dto: RestoreResponseDto; audit: ApiAuditDetail } | { kind: 'not_found' };

/** Surface consumed by the quarantine routes. */
export interface QuarantineServiceLike {
  list(
    member: ProjectMember,
    projectId: string,
    q: QuarantineQueryInput,
  ): Promise<QuarantineListDto>;
  get(member: ProjectMember, projectId: string, id: string): Promise<QuarantineDetailDto | null>;
  /** Caller must have checked member.projectRole === 'project_admin'. */
  restore(member: ProjectMember, projectId: string, id: string): Promise<RestoreOutcome>;
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

  async restore(member: ProjectMember, projectId: string, id: string): Promise<RestoreOutcome> {
    const claim = await this.deps.quarantineRepository.claimForRestore({
      projectId,
      quarantineId: id,
      restoredByUserId: member.userId,
      openedBy: member.actorId,
    });
    if (claim.status === 'not_found') return { kind: 'not_found' };

    let result;
    try {
      result = await this.deps.promoteService.promoteItem(claim.sessionId, claim.itemId, {
        tenant: { projectId, repoId: claim.repoId, branch: claim.branch },
        originBranch: claim.branch,
        originPr: claim.originPr,
      });
    } catch (err) {
      // The claim is committed: the item stays pending in its restore session.
      logger.error('[quarantine] restore pipeline failed after claim', {
        quarantineId: id,
        itemId: claim.itemId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      throw err;
    }

    const audit: ApiAuditDetail = { quarantineId: id, itemId: claim.itemId };
    switch (result.outcome) {
      case 'applied': {
        const dto: RestoreResponseDto = { outcome: 'applied' };
        if (result.memoryId) dto.memoryId = result.memoryId;
        return {
          kind: 'restored',
          dto,
          audit: { ...audit, outcome: 'applied', memoryId: result.memoryId ?? undefined },
        };
      }
      case 'queued':
        return {
          kind: 'restored',
          dto: { outcome: 'queued', itemId: result.itemId },
          audit: { ...audit, outcome: 'queued' },
        };
      case 'quarantined': {
        const dto: RestoreResponseDto = { outcome: 'quarantined' };
        if (result.quarantineId) dto.quarantineId = result.quarantineId;
        return {
          kind: 'restored',
          dto,
          audit: {
            ...audit,
            outcome: 'quarantined',
            newQuarantineId: result.quarantineId ?? undefined,
          },
        };
      }
      case 'conflict':
        // Human-approved mode only (C5): restore never passes the option.
        logger.error('[quarantine] restore produced a human-approval conflict', {
          quarantineId: id,
          itemId: claim.itemId,
        });
        throw new AppError(ErrorCode.INTERNAL);
      default:
        // 'skipped' is impossible for a freshly claimed pending item.
        logger.error('[quarantine] restore produced an unexpected outcome', {
          quarantineId: id,
          itemId: claim.itemId,
          outcome: result.outcome,
        });
        throw new AppError(ErrorCode.INTERNAL);
    }
  }
}
