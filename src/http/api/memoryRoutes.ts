/**
 * Memory lifecycle routes (C4, HU-12.2, HU-12.3, HU-11.4), mounted on the nested
 * /v1/projects/:projectId router behind makeProjectAdmin — so a non-admin never
 * reaches validation and gets the same opaque 404.
 *
 *   GET  /memories                      list (pending_revalidation)  → memories.list
 *   POST /memories/retire-by-pr         bulk retire by origin PR     → memory.retire_by_pr
 *   POST /memories/:memoryId/confirm    pending → active             → memory.confirm
 *   POST /memories/:memoryId/retire     active|pending → deprecated  → memory.retire
 *
 * Order: projectAdmin → JSON content type on POSTs (same as the review routes)
 * → uuid :memoryId (else 404) → zod (else 400) → service. not_found (absent, foreign, wrong status, repeat) is
 * the uniform 404. Audit runs only after success and never carries the reason;
 * an audit failure after a committed write is logged (ids only) and is a 500.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { logger } from '../../observability/logger.js';
import { adminContext, parseOrInvalid, requireJsonContentType } from './reviewRoutes.js';
import type { ApiResponse, ApiRouterDeps } from './types.js';

/** C5 widens the status enum and adds filters, search and a cursor. */
export const MemoryListQuery = z
  .object({
    status: z.enum(['pending_revalidation']).default('pending_revalidation'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const ConfirmBody = z.object({}).strict();

const Reason = z.string().trim().min(3).max(500);

const RetireBody = z.object({ reason: Reason }).strict();

const RetireByPrBody = z
  .object({
    originPr: z.number().int().positive(),
    reason: Reason,
  })
  .strict();

const MemoryId = z.string().uuid();

type MemoryParams = { projectId: string; memoryId: string };

/** Malformed memory ids get the same 404 as a missing memory. */
function parseMemoryId(raw: string): string {
  const parsed = MemoryId.safeParse(raw);
  if (!parsed.success) throw new AppError(ErrorCode.NOT_FOUND);
  return parsed.data;
}

/** The write is already committed: log the failure (ids only), then fail closed. */
async function auditCommitted(
  ids: Record<string, unknown>,
  audit: () => Promise<void>,
): Promise<void> {
  try {
    await audit();
  } catch (err) {
    logger.error('[api] audit failed after committed lifecycle change', {
      ...ids,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    throw err;
  }
}

export function makeMemoryRoutes(
  deps: Pick<ApiRouterDeps, 'lifecycleService' | 'auditLogger'>,
): express.Router {
  const { lifecycleService, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/memories', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    const q = parseOrInvalid(MemoryListQuery, req.query);

    const dto = await lifecycleService.list(project.projectId, q);
    await auditLogger.recordApi(actor, project, 'memories.list', {
      status: q.status,
      resultCount: dto.items.length,
    });
    res.status(200).json(dto);
  });

  router.post(
    '/memories/retire-by-pr',
    requireJsonContentType,
    async (req: Request, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const body = parseOrInvalid(RetireByPrBody, req.body ?? {});

      const outcome = await lifecycleService.retireByPr(
        actor,
        project.projectId,
        body.originPr,
        body.reason,
      );
      if (outcome.kind === 'invalid_reason') throw new AppError(ErrorCode.INVALID_REQUEST);

      await auditCommitted({ originPr: body.originPr }, () =>
        auditLogger.recordApi(actor, project, 'memory.retire_by_pr', {
          originPr: body.originPr,
          resultCount: outcome.dto.retired,
        }),
      );
      res.status(200).json(outcome.dto);
    },
  );

  router.post(
    '/memories/:memoryId/confirm',
    requireJsonContentType,
    async (req: Request<MemoryParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const memoryId = parseMemoryId(req.params.memoryId);
      // No body (Express 5 leaves req.body undefined) is an empty confirm.
      parseOrInvalid(ConfirmBody, req.body ?? {});

      const outcome = await lifecycleService.confirm(actor, project.projectId, memoryId);
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);

      await auditCommitted({ memoryId }, () =>
        auditLogger.recordApi(actor, project, 'memory.confirm', { memoryId }),
      );
      res.status(200).json(outcome.dto);
    },
  );

  router.post(
    '/memories/:memoryId/retire',
    requireJsonContentType,
    async (req: Request<MemoryParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const memoryId = parseMemoryId(req.params.memoryId);
      const body = parseOrInvalid(RetireBody, req.body ?? {});

      const outcome = await lifecycleService.retire(
        actor,
        project.projectId,
        memoryId,
        body.reason,
      );
      if (outcome.kind === 'invalid_reason') throw new AppError(ErrorCode.INVALID_REQUEST);
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);

      await auditCommitted({ memoryId }, () =>
        auditLogger.recordApi(actor, project, 'memory.retire', { memoryId }),
      );
      res.status(200).json(outcome.dto);
    },
  );

  return router;
}
