/**
 * Memory lifecycle service contract (C4, HU-12, HU-11.4): consumed by the
 * /api memory routes, the revalidation-sweep job and the job script.
 */

import type { JobResult } from '../jobs/jobsRouter.js';
import type { AdminActor } from '../mcp/context.js';
import type {
  ConfirmResponseDto,
  MemoryListDto,
  MemoryListQueryInput,
  RetireByPrResponseDto,
  RetireResponseDto,
} from '../http/api/types.js';

export type ConfirmOutcome = { kind: 'confirmed'; dto: ConfirmResponseDto } | { kind: 'not_found' };

export type RetireOutcome =
  { kind: 'retired'; dto: RetireResponseDto } | { kind: 'not_found' } | { kind: 'invalid_reason' };

export type RetireByPrOutcome =
  { kind: 'retired'; dto: RetireByPrResponseDto } | { kind: 'invalid_reason' };

export interface LifecycleServiceLike {
  list(projectId: string, q: MemoryListQueryInput): Promise<MemoryListDto>;
  confirm(actor: AdminActor, projectId: string, memoryId: string): Promise<ConfirmOutcome>;
  retire(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    reason: string,
  ): Promise<RetireOutcome>;
  retireByPr(
    actor: AdminActor,
    projectId: string,
    originPr: number,
    reason: string,
  ): Promise<RetireByPrOutcome>;
  /** { job: 'revalidation-sweep', count: total, detail: { [projectId]: n } } */
  sweep(): Promise<JobResult>;
}

export const REVALIDATION_SWEEP_JOB = 'revalidation-sweep';
