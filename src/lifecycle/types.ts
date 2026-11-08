/**
 * Memory lifecycle service contract (C4, HU-12, HU-11.4): consumed by the
 * /api memory routes, the revalidation-sweep job and the job script.
 */

import type { JobResult } from '../jobs/jobsRouter.js';
import type { AdminActor, ApiWriteAudit } from '../mcp/context.js';
import type {
  ConfirmResponseDto,
  RetireByPrResponseDto,
  RetireResponseDto,
} from '../http/api/types.js';

export type ConfirmOutcome = { kind: 'confirmed'; dto: ConfirmResponseDto } | { kind: 'not_found' };

export type RetireOutcome =
  { kind: 'retired'; dto: RetireResponseDto } | { kind: 'not_found' } | { kind: 'invalid_reason' };

export type RetireByPrOutcome =
  { kind: 'retired'; dto: RetireByPrResponseDto } | { kind: 'invalid_reason' };

/**
 * `audit` (C11) writes the route's access_log row in the same transaction as
 * the change; it runs only when something was written (never on not_found or
 * invalid_reason) and its failure rolls the change back.
 */
export interface LifecycleServiceLike {
  confirm(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    audit: ApiWriteAudit,
  ): Promise<ConfirmOutcome>;
  retire(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    reason: string,
    audit: ApiWriteAudit,
  ): Promise<RetireOutcome>;
  retireByPr(
    actor: AdminActor,
    projectId: string,
    originPr: number,
    reason: string,
    audit: ApiWriteAudit,
  ): Promise<RetireByPrOutcome>;
  /** { job: 'revalidation-sweep', count: total, detail: { [projectId]: n } } */
  sweep(): Promise<JobResult>;
}

export const REVALIDATION_SWEEP_JOB = 'revalidation-sweep';
