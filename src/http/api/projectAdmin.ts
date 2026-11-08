/**
 * Gate 2 for project routes: `:projectId` must be a UUID (else NOT_FOUND, so a
 * malformed id never reaches SQL) and the caller must be that project's
 * project_admin. Every denial is the same opaque 404 as a missing project.
 *
 * On success: res.locals.actor (AdminActor) and res.locals.project.
 */

import type { NextFunction, Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import type { Authorizer } from '../../mcp/context.js';
import type { ApiResponse } from './types.js';

const ProjectId = z.string().uuid();

export function makeProjectAdmin(
  authorizer: Authorizer,
): (req: Request<{ projectId: string }>, res: ApiResponse, next: NextFunction) => Promise<void> {
  return async (
    req: Request<{ projectId: string }>,
    res: ApiResponse,
    next: NextFunction,
  ): Promise<void> => {
    const parsed = ProjectId.safeParse(req.params.projectId);
    if (!parsed.success) {
      next(new AppError(ErrorCode.NOT_FOUND));
      return;
    }

    // authorizeProjectAdmin throws an opaque PERMISSION_DENIED (→ 404) on any failure.
    const actor = await authorizer.authorizeProjectAdmin(res.locals.principal, parsed.data);
    res.locals.actor = actor;
    res.locals.project = { projectId: parsed.data };
    next();
  };
}
