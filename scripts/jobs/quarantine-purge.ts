/**
 * `pnpm job:quarantine-purge` — retention purge of expired quarantine rows (HU-10.3).
 *
 * Same function as POST /internal/jobs/quarantine-purge (purgeExpiredQuarantine),
 * audited with trigger 'script'. Follows the migrate.ts pattern: reads
 * DATABASE_URL directly (no loadConfig, so no Cognito vars are needed), guards
 * the CLI behind a main-module check, prints the JSON result (counts only) and
 * exits 1 on error after logging.
 *
 * Production scheduling uses the HTTP endpoint (EventBridge Scheduler; the
 * Fargate image does not ship tsx) — see DEVELOPMENT.md.
 */

import { pathToFileURL } from 'node:url';
import { createPool, closePool } from '../../src/db/pool.js';
import { PgQuarantineRepository } from '../../src/db/quarantineRepository.js';
import { PgAuthRepository } from '../../src/db/authRepository.js';
import { RdsAuditLogger } from '../../src/auth/auditLogger.js';
import { purgeExpiredQuarantine } from '../../src/quarantine/purge.js';
import type { JobResult } from '../../src/jobs/jobsRouter.js';

export async function runQuarantinePurge(connectionString: string): Promise<JobResult> {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = createPool(connectionString, process.env.NODE_ENV === 'production');
  try {
    const result = await purgeExpiredQuarantine(new PgQuarantineRepository(pool));
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
  runQuarantinePurge(process.env.DATABASE_URL ?? '')
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((err: unknown) => {
      // Error name/message only — the purge never handles content.
      console.error(
        '[job:quarantine-purge] failed:',
        err instanceof Error ? err.message : 'unknown error',
      );
      process.exit(1);
    });
}
