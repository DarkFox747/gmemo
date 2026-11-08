/**
 * REST router, mounted at /api by createApp (behind the /api rate limiter).
 *
 * Chain: no-store → apiAuth (Gate 1) → /v1/me
 *                                    → /v1/projects/:projectId/quarantine → projectMember (Gate 2, any role)
 *                                                                         → quarantine routes (C3)
 *                                    → /v1/projects/:projectId → projectAdmin (Gate 2) → review routes
 *                                    → catch-all JSON 404
 *
 * The catch-all means an unknown /api/* path is a JSON 404 (401 when
 * unauthenticated) and never reaches static/SPA handling. Errors are mapped by
 * apiErrorHandler, which createApp mounts at app level on '/api'.
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { makeApiAuth } from './apiAuth.js';
import { makeProjectAdmin } from './projectAdmin.js';
import { makeMeRouter } from './meRoutes.js';
import { makeReviewRouter } from './reviewRoutes.js';
import { makeProjectMember } from './projectMember.js';
import { makeQuarantineRouter } from './quarantineRoutes.js';
import type { ApiRouterDeps, ApiRouterOptions } from './types.js';

export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'no-store');
  next();
}

export function makeApiRouter(deps: ApiRouterDeps, o: ApiRouterOptions): express.Router {
  const router = express.Router();

  router.use(noStore);
  router.use(makeApiAuth(deps.authenticator, o));
  router.use(makeMeRouter(deps));
  // Before the admin-only project router: quarantine reads are open to any member.
  router.use(
    '/v1/projects/:projectId/quarantine',
    makeProjectMember(deps.authorizer),
    makeQuarantineRouter(deps),
  );
  router.use('/v1/projects/:projectId', makeProjectAdmin(deps.authorizer), makeReviewRouter(deps));
  router.use(() => {
    throw new AppError(ErrorCode.NOT_FOUND);
  });

  return router;
}
