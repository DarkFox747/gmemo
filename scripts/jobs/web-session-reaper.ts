/**
 * `pnpm job:web-session-reaper` — abandons direct-write (`web/%`) staging
 * sessions a crash left open for more than 5 minutes and deletes their
 * non-promoted items (C5 SEC-M1).
 *
 * Same function as POST /internal/jobs/web-session-reaper (reapStaleWebSessions),
 * audited with trigger 'script'. Follows the quarantine-purge script pattern:
 * reads DATABASE_URL directly (no loadConfig, so no Cognito vars are needed),
 * guards the CLI behind a main-module check, prints the JSON result (counts
 * only) and exits 1 on error after logging.
 *
 * Production scheduling uses the HTTP endpoint (EventBridge Scheduler) — see
 * DEVELOPMENT.md.
 */

import { pathToFileURL } from 'node:url';
import { createPool, closePool } from '../../src/db/pool.js';
import { PgStagingRepository } from '../../src/db/stagingRepository.js';
import { PgAuthRepository } from '../../src/db/authRepository.js';
import { RdsAuditLogger } from '../../src/auth/auditLogger.js';
import { reapStaleWebSessions } from '../../src/memory/webSessionReaper.js';
import type { JobResult } from '../../src/jobs/jobsRouter.js';

export async function runWebSessionReaper(connectionString: string): Promise<JobResult> {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = createPool(connectionString, process.env.NODE_ENV === 'production');
  try {
    const result = await reapStaleWebSessions(new PgStagingRepository(pool));
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
  runWebSessionReaper(process.env.DATABASE_URL ?? '')
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((err: unknown) => {
      // Error name/message only — the reaper never handles content.
      console.error(
        '[job:web-session-reaper] failed:',
        err instanceof Error ? err.message : 'unknown error',
      );
      process.exit(1);
    });
}
