/**
 * Gate 2 for member-level project routes (C3 quarantine): `:projectId` must be a
 * UUID (else NOT_FOUND, so a malformed id never reaches SQL) and the caller must
 * hold ANY membership on that (non-archived) project. Every denial is the same
 * opaque 404 as a missing project. Role-specific rules (admin vs author) are
 * applied by the routes from res.locals.member.projectRole.
 *
 * On success: res.locals.member (ProjectMember) and res.locals.project.
 */

import type { NextFunction, Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import type { Authorizer } from '../../mcp/context.js';
import type { ApiResponse } from './types.js';

const ProjectId = z.string().uuid();

export function makeProjectMember(
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

    // authorizeProjectMember throws an opaque PERMISSION_DENIED (→ 404) on any failure.
    const member = await authorizer.authorizeProjectMember(res.locals.principal, parsed.data);
    res.locals.member = member;
    res.locals.project = { projectId: parsed.data };
    next();
  };
}
