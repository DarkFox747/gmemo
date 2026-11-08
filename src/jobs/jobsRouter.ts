/**
 * Internal jobs router (C3; shared contract with C4), mounted at /internal/jobs.
 *
 *   POST /internal/jobs/:job   → runs deps.jobs[job](), audits, 200 JobResult
 *
 * Every refusal is the SAME opaque 404 {"error":"Not found"} (disabled router,
 * missing/bad token, unknown job, wrong method, any other path), so the endpoint
 * cannot be enumerated. Every response is Cache-Control: no-store.
 *
 * Enablement (three layers, so unauthenticated mode only exists in development):
 *  1. config: JOBS_TOKEN optional, ≥32 chars;
 *  2. composition root: enabled = isJobsEnabled(NODE_ENV, token);
 *  3. here: open mode (enabled, no token) is honoured only when
 *     isOpenMode(process.env.NODE_ENV) at factory time — NODE_ENV must be exactly
 *     'development' (SEC-M3): production, test or an unset NODE_ENV → disabled.
 * Token mode: `Authorization: Bearer <t>`, compared as sha256 digests with
 * timingSafeEqual (equal-length buffers: constant time, no length leak). Once a
 * token is configured it is required in every environment. A rejected token is
 * logged as a warning (never the token itself).
 *
 * Rate limit (SEC-L4): a fixed 10 requests/min per client in front of every
 * route (config-free: the jobs run daily), with the shared opaque 429.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AuditLogger } from '../mcp/context.js';
import { makeRateLimiter } from '../http/rateLimit.js';
import { logger } from '../observability/logger.js';

export interface JobResult {
  job: string;
  count: number;
  /** Counts keyed by project id (never content). */
  detail?: Record<string, number>;
}

export interface JobsRouterDeps {
  jobs: Record<string, () => Promise<JobResult>>;
  token?: string;
  enabled: boolean;
  audit: Pick<AuditLogger, 'recordJob'>;
}

const JOB_NAME = /^[a-z0-9-]{1,64}$/;
const BEARER = /^Bearer (\S+)$/;

/** Open mode (no token) is only possible with an explicit NODE_ENV=development. */
export function isOpenMode(nodeEnv: string | undefined, token: string | undefined): boolean {
  return token === undefined && nodeEnv === 'development';
}

/** Enabled = a token is configured (any env) or open mode (development only). */
export function isJobsEnabled(nodeEnv: string | undefined, token: string | undefined): boolean {
  return token !== undefined || isOpenMode(nodeEnv, token);
}

const JOBS_RATE_LIMIT = { windowMs: 60_000, max: 10 } as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function makeJobsRouter(deps: JobsRouterDeps): express.Router {
  const router = express.Router();
  const active = deps.enabled && isJobsEnabled(process.env.NODE_ENV, deps.token);
  const expected = deps.token === undefined ? null : digest(deps.token);

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(makeRateLimiter(JOBS_RATE_LIMIT));

  const authorized = (req: Request): boolean => {
    if (!active) return false;
    if (expected === null) return true; // open mode (development only, see above)
    const m = BEARER.exec(req.get('authorization') ?? '');
    if (m && timingSafeEqual(digest(m[1]!), expected)) return true;
    // Never log the presented value.
    logger.warn('[jobs] rejected request: missing or invalid token');
    return false;
  };

  router.post('/:job', async (req: Request<{ job: string }>, res: Response, next: NextFunction) => {
    const { job } = req.params;
    if (!authorized(req) || !JOB_NAME.test(job) || !Object.hasOwn(deps.jobs, job)) {
      notFound(res);
      return;
    }
    try {
      const result = await deps.jobs[job]!();
      // Audit after success; an audit failure is a 500 (fail closed).
      await deps.audit.recordJob({ ...result, trigger: 'http' });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Catch-all: nothing under /internal/jobs falls through to static/SPA handling.
  router.use((_req: Request, res: Response) => {
    notFound(res);
  });

  return router;
}
