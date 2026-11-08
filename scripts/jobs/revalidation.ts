/**
 * `pnpm job:revalidation` — revalidation sweep (C4, HU-12.1): active non-outcome
 * memories past revalidate_at become pending_revalidation.
 *
 * Same function as POST /internal/jobs/revalidation-sweep (LifecycleService.sweep),
 * audited with trigger 'script'. Follows the quarantine-purge script pattern:
 * reads DATABASE_URL directly (no loadConfig, so no Cognito vars are needed),
 * validates REVALIDATION_DAYS with the same zod field as the config, guards the
 * CLI behind a main-module check, prints the JSON result (counts only) and exits
 * 1 on error after logging.
 *
 * Production scheduling uses the HTTP endpoint (EventBridge Scheduler, daily) —
 * see DEVELOPMENT.md.
 */

import { pathToFileURL } from 'node:url';
import { createPool, closePool } from '../../src/db/pool.js';
import { PgLifecycleRepository } from '../../src/db/lifecycleRepository.js';
import { PgAuthRepository } from '../../src/db/authRepository.js';
import { RdsAuditLogger } from '../../src/auth/auditLogger.js';
import { LifecycleService } from '../../src/lifecycle/lifecycleService.js';
import { revalidationDaysSchema } from '../../src/config/index.js';
import type { JobResult } from '../../src/jobs/jobsRouter.js';

export async function runRevalidationSweep(
  connectionString: string,
  rawRevalidationDays: string | undefined = process.env.REVALIDATION_DAYS,
): Promise<JobResult> {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const days = revalidationDaysSchema.safeParse(rawRevalidationDays);
  if (!days.success) throw new Error('REVALIDATION_DAYS must be an integer between 1 and 3650');

  const pool = createPool(connectionString, process.env.NODE_ENV === 'production');
  try {
    const service = new LifecycleService({
      lifecycleRepository: new PgLifecycleRepository(pool, { revalidationDays: days.data }),
    });
    const result = await service.sweep();
    await new RdsAuditLogger(new PgAuthRepository(pool)).recordJob({
      ...result,
      trigger: 'script',
    });
    return result;
  } finally {
    await closePool(pool);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRevalidationSweep(process.env.DATABASE_URL ?? '')
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((err: unknown) => {
      // Error name/message only — the sweep never handles content.
      console.error(
        '[job:revalidation] failed:',
        err instanceof Error ? err.message : 'unknown error',
      );
      process.exit(1);
    });
}
