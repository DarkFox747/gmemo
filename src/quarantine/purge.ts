/**
 * Retention purge (HU-10.3): deletes quarantine rows past expires_at. Shared by
 * POST /internal/jobs/quarantine-purge and `pnpm job:quarantine-purge`. A plain
 * function so the script needs only a pool and the repository.
 */

import type { QuarantineRepository } from '../db/quarantineRepository.js';
import type { JobResult } from '../jobs/jobsRouter.js';

export const QUARANTINE_PURGE_JOB = 'quarantine-purge';

export async function purgeExpiredQuarantine(
  repo: Pick<QuarantineRepository, 'purgeExpired'>,
): Promise<JobResult> {
  const perProject = await repo.purgeExpired();
  const detail: Record<string, number> = {};
  let count = 0;
  for (const { projectId, count: n } of perProject) {
    detail[projectId] = n;
    count += n;
  }
  return { job: QUARANTINE_PURGE_JOB, count, detail };
}
