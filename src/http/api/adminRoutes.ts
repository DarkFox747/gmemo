/**
 * Administration summary route (C7), mounted on the nested
 * /v1/projects/:projectId router behind makeProjectAdmin:
 *
 *   GET /admin-summary   project, repos, members, credentials → admin_summary.read
 *
 * Read-only and secret-free (no token or token hash ever leaves the
 * repository). No query string is accepted; the check runs after projectAdmin,
 * so a non-admin always gets the opaque 404. Audit runs only after success and
 * carries the member count only (no emails).
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { adminContext, parseOrInvalid } from './reviewRoutes.js';
import type { ApiResponse, ApiRouterDeps } from './types.js';

const NoQuery = z.object({}).strict();

export function makeAdminRoutes(
  deps: Pick<ApiRouterDeps, 'adminSummaryRepository' | 'auditLogger'>,
): express.Router {
  const { adminSummaryRepository, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/admin-summary', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    parseOrInvalid(NoQuery, req.query);

    const dto = await adminSummaryRepository.getAdminSummary(project.projectId);
    if (!dto) throw new AppError(ErrorCode.NOT_FOUND);

    await auditLogger.recordApi(actor, project, 'admin_summary.read', {
      resultCount: dto.members.length,
    });
    res.status(200).json(dto);
  });

  return router;
}
