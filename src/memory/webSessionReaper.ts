/**
 * web-session-reaper (C5 SEC-M1): closes direct-write staging sessions a crash
 * left open.
 *
 * A direct confirm creates a one-item `web/<userId>/<sessionId>` session and
 * always closes it in-process (finalize or abandon). A process crash between the
 * insert and that close leaves the session `open` with a pending item. This job
 * abandons every `web/%` session still open after WEB_SESSION_MAX_AGE_MINUTES
 * and deletes its non-promoted items, in one guarded statement (promoted items
 * are kept: memory_revision.promoted_from_item points at them).
 *
 * Shared by POST /internal/jobs/web-session-reaper and `pnpm job:web-session-reaper`.
 * Counts only (per project), never content.
 */

import type { JobResult } from '../jobs/jobsRouter.js';

export const WEB_SESSION_REAPER_JOB = 'web-session-reaper';

/**
 * A live confirm finishes in well under a minute (judge timeout × attempts +
 * apply), so 5 minutes never races an in-flight request.
 */
export const WEB_SESSION_MAX_AGE_MINUTES = 5;

export interface WebSessionReaperRepository {
  /** Abandons open `web/%` sessions older than the cutoff; sessions reaped per project. */
  reapStaleWebSessions(maxAgeMinutes: number): Promise<Array<{ projectId: string; count: number }>>;
}

export async function reapStaleWebSessions(repo: WebSessionReaperRepository): Promise<JobResult> {
  const perProject = await repo.reapStaleWebSessions(WEB_SESSION_MAX_AGE_MINUTES);
  const detail: Record<string, number> = {};
  let count = 0;
  for (const { projectId, count: n } of perProject) {
    detail[projectId] = n;
    count += n;
  }
  return { job: WEB_SESSION_REAPER_JOB, count, detail };
}
