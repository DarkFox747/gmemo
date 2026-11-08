/**
 * LifecycleService (C4, HU-12, HU-11.4): thin orchestration over
 * LifecycleRepository for the /api memory routes, the revalidation-sweep job
 * and `pnpm job:revalidation`.
 *
 * - Retire reasons follow the C2 reject policy: a secret → invalid_reason
 *   (never stored or echoed, checked before any DB call); PII masked; a reason
 *   masking pushed past 500 chars is clamped (the DB CHECK is the backstop).
 * - sweep() turns per-project counts into the shared JobResult shape. A DB
 *   error propagates to the caller (jobs router / script), which logs it.
 * - The route binds the audit row (actor, action); the repository writes it in
 *   the change's own transaction (C11). The service supplies the detail.
 */

import type { LifecycleRepository } from '../db/lifecycleRepository.js';
import type { JobResult } from '../jobs/jobsRouter.js';
import type { AdminActor, ApiWriteAudit } from '../mcp/context.js';
import { scanForSecrets } from '../security/secretScan.js';
import { normalizeForScan } from '../security/normalizeForScan.js';
import { maskPii } from '../security/piiMask.js';
import { logger } from '../observability/logger.js';
import {
  REVALIDATION_SWEEP_JOB,
  type ConfirmOutcome,
  type LifecycleServiceLike,
  type RetireByPrOutcome,
  type RetireOutcome,
} from './types.js';

export type { LifecycleServiceLike } from './types.js';

/** memory.retired_reason budget (ck_memory_retired_reason_len). */
const REASON_MAX = 500;

export interface LifecycleServiceDeps {
  lifecycleRepository: LifecycleRepository;
}

/**
 * Applies the reason policy. Returns the reason to store, or null when it must
 * be refused. Logs ids only — never the reason.
 */
function sanitizeReason(reason: string, logCtx: Record<string, unknown>): string | null {
  if (scanForSecrets(normalizeForScan(reason)).length > 0) {
    logger.warn('[lifecycle] retire reason rejected: secret detected', logCtx);
    return null;
  }
  try {
    return maskPii(reason).text.slice(0, REASON_MAX);
  } catch (err) {
    // Fail closed: an unmaskable reason is never stored.
    logger.warn('[lifecycle] retire reason could not be PII-masked', {
      ...logCtx,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

export class LifecycleService implements LifecycleServiceLike {
  constructor(private readonly deps: LifecycleServiceDeps) {}

  async confirm(
    _actor: AdminActor,
    projectId: string,
    memoryId: string,
    audit: ApiWriteAudit,
  ): Promise<ConfirmOutcome> {
    const r = await this.deps.lifecycleRepository.confirm(projectId, memoryId, (db, done) =>
      audit(db, { memoryId: done.memoryId }),
    );
    if (!r) return { kind: 'not_found' };
    return {
      kind: 'confirmed',
      dto: {
        memoryId: r.memoryId,
        status: 'active',
        revalidateAt: r.revalidateAt?.toISOString() ?? null,
      },
    };
  }

  async retire(
    actor: AdminActor,
    projectId: string,
    memoryId: string,
    reason: string,
    audit: ApiWriteAudit,
  ): Promise<RetireOutcome> {
    const safe = sanitizeReason(reason, { memoryId });
    if (safe === null) return { kind: 'invalid_reason' };
    const r = await this.deps.lifecycleRepository.retire(
      projectId,
      memoryId,
      safe,
      actor.actorId,
      (db, done) => audit(db, { memoryId: done.memoryId }),
    );
    if (!r) return { kind: 'not_found' };
    return {
      kind: 'retired',
      dto: { memoryId: r.memoryId, status: 'deprecated', version: r.revision },
    };
  }

  async retireByPr(
    actor: AdminActor,
    projectId: string,
    originPr: number,
    reason: string,
    audit: ApiWriteAudit,
  ): Promise<RetireByPrOutcome> {
    const safe = sanitizeReason(reason, { originPr });
    if (safe === null) return { kind: 'invalid_reason' };
    const r = await this.deps.lifecycleRepository.retireByPr(
      projectId,
      originPr,
      safe,
      actor.actorId,
      (db, done) => audit(db, { originPr, resultCount: done.retired }),
    );
    return { kind: 'retired', dto: { retired: r.retired } };
  }

  async sweep(): Promise<JobResult> {
    const perProject = await this.deps.lifecycleRepository.sweepExpired();
    const detail: Record<string, number> = {};
    let count = 0;
    for (const { projectId, count: n } of perProject) {
      detail[projectId] = n;
      count += n;
    }
    return { job: REVALIDATION_SWEEP_JOB, count, detail };
  }
}
