/**
 * Direct memory management contracts (C5, HU-13): consumed by the /api memory
 * routes and implemented by DirectMemoryService.
 */

import type { MemoryType } from '../contracts/memory.js';
import type { AdminActor, ApiAuditDetail } from '../mcp/context.js';
import type {
  ConflictCode,
  DirectWriteResponseDto,
  MemoryDetailDto,
  MemoryListDto,
  MemoryListQueryInput,
  PreviewResponseDto,
} from '../http/api/types.js';
import type { MemoryAdminRepository } from '../db/memoryAdminRepository.js';
import type { StagingRepository } from '../db/stagingRepository.js';
import type { PromotionRepository } from '../db/promotionRepository.js';
import type { PromoteServiceLike } from '../promote/promoteService.js';
import type { ReviewQueueRepository } from '../db/reviewQueueRepository.js';
import type { QuarantineRepository } from '../db/quarantineRepository.js';
import type { Judge } from '../judge/judge.js';
import type { RoutingConfig } from '../promote/routing.js';

/** A proposed unit, already validated by the route (budgets, per-type fields). */
export interface UnitInput {
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  /** null → the project's first repo. */
  repoId: string | null;
}

export type PreviewInput =
  | (UnitInput & { op: 'add' })
  | (UnitInput & { op: 'amend'; targetMemoryId: string; expectedRevision: number });

export type AmendInput = UnitInput & { expectedRevision: number };

export type PreviewOutcome =
  | { kind: 'ok'; dto: PreviewResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: ConflictCode }
  | { kind: 'invalid' };

export type WriteOutcome =
  | { kind: 'done'; dto: DirectWriteResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: ConflictCode }
  | { kind: 'invalid' }
  /** SEC-M2: the judge or its context failed closed; nothing applied, session abandoned (503). */
  | { kind: 'unavailable' };

export interface DirectMemoryServiceLike {
  list(projectId: string, q: MemoryListQueryInput): Promise<MemoryListDto>;
  get(projectId: string, memoryId: string): Promise<MemoryDetailDto | null>;
  preview(actor: AdminActor, projectId: string, input: PreviewInput): Promise<PreviewOutcome>;
  create(actor: AdminActor, projectId: string, input: UnitInput): Promise<WriteOutcome>;
  amend(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    input: AmendInput,
  ): Promise<WriteOutcome>;
}

export interface DirectMemoryServiceDeps {
  memoryAdminRepository: MemoryAdminRepository;
  stagingRepository: Pick<StagingRepository, 'createSingleItemSession'>;
  promotionRepository: Pick<PromotionRepository, 'findJudgeContext' | 'abandonOpenSession'>;
  promoteService: Pick<PromoteServiceLike, 'promoteItem'>;
  reviewQueueRepository: Pick<ReviewQueueRepository, 'findMemoryRefs'>;
  quarantineRepository: Pick<QuarantineRepository, 'findVisible'>;
  judge: Judge;
  /** The SAME instance PromoteService uses, so preview and confirm route identically. */
  routing: RoutingConfig;
}
