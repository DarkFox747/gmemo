/**
 * Review-queue routes (HU-07), mounted on a nested router at
 * /v1/projects/:projectId behind makeProjectAdmin — so validation always runs
 * AFTER authorization (a non-admin with a bad body gets 404, not 400).
 *
 *   GET  /review-queue                   list (+ counters)        → review_queue.list
 *   GET  /review-queue/:itemId           detail                   → review_queue.read
 *   POST /review-queue/:itemId/approve   approve                  → review_queue.approve
 *   POST /review-queue/:itemId/reject    reject (reason required) → review_queue.reject
 *
 * Audit runs only after success; an audit failure propagates as a 500 (fail
 * closed). 409 is written directly: it is an expected approve outcome, and the
 * caller is already proven project_admin of the item's project.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { logger } from '../../observability/logger.js';
import { MEMORY_TYPES } from '../../mcp/tools/schemas.js';
import type { AdminActor, ProjectContext } from '../../mcp/context.js';
import type { ApiErrorBody, ApiResponse, ApiRouterDeps } from './types.js';

const QueueQuery = z
  .object({
    filter: z.enum(['all', 'uncertain', 'mandatory']).default('all'),
    type: z.enum(MEMORY_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const ApproveBody = z
  .object({
    markRelatedSuperseded: z.boolean().default(false),
    /** The target version the reviewer saw (confirms a stale-target rebase). */
    targetRevision: z.number().int().positive().optional(),
  })
  .strict();

const RejectBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const ItemId = z.string().uuid();

const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

/** State-changing POSTs must be JSON (blocks form-encoded cross-site posts). Runs after authz. */
export function requireJsonContentType(req: Request, _res: ApiResponse, next: express.NextFunction): void {
  if (req.method === 'POST' && !JSON_CONTENT_TYPE.test(req.get('content-type') ?? '')) {
    throw new AppError(ErrorCode.INVALID_REQUEST);
  }
  next();
}

type ItemParams = { projectId: string; itemId: string };

/** projectAdmin always sets these; their absence is a wiring bug, not a client error. */
export function adminContext(res: ApiResponse): { actor: AdminActor; project: ProjectContext } {
  const { actor, project } = res.locals;
  if (!actor || !project) throw new AppError(ErrorCode.INTERNAL);
  return { actor, project };
}

/** Malformed item ids get the same 404 as a missing item. */
function parseItemId(raw: string): string {
  const parsed = ItemId.safeParse(raw);
  if (!parsed.success) throw new AppError(ErrorCode.NOT_FOUND);
  return parsed.data;
}

export function parseOrInvalid<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST);
  return parsed.data;
}

export function makeReviewRouter(
  deps: Pick<ApiRouterDeps, 'reviewService' | 'auditLogger'>,
): express.Router {
  const { reviewService, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });
  router.use(requireJsonContentType);

  /** The decision is already committed: log the failure (ids only), then fail closed. */
  async function auditCommitted(
    itemId: string,
    audit: () => Promise<void>,
  ): Promise<void> {
    try {
      await audit();
    } catch (err) {
      logger.error('[api] audit failed after committed review decision', { itemId, errorName: err instanceof Error ? err.name : 'unknown' });
      throw err;
    }
  }

  router.get('/review-queue', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    const q = parseOrInvalid(QueueQuery, req.query);

    const dto = await reviewService.list(project.projectId, q);
    await auditLogger.recordApi(actor, project, 'review_queue.list', {
      filter: q.filter,
      type: q.type,
      resultCount: dto.items.length,
    });
    res.status(200).json(dto);
  });

  router.get(
    '/review-queue/:itemId',
    async (req: Request<ItemParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const itemId = parseItemId(req.params.itemId);

      const dto = await reviewService.get(project.projectId, itemId);
      if (!dto) throw new AppError(ErrorCode.NOT_FOUND);

      await auditLogger.recordApi(actor, project, 'review_queue.read', { itemId });
      res.status(200).json(dto);
    },
  );

  router.post(
    '/review-queue/:itemId/approve',
    async (req: Request<ItemParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const itemId = parseItemId(req.params.itemId);
      // No body (Express 5 leaves req.body undefined) means "all defaults".
      const body = parseOrInvalid(ApproveBody, req.body ?? {});

      const outcome = await reviewService.approve(actor, project.projectId, itemId, body);
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);
      if (outcome.kind === 'conflict') {
        const conflict: ApiErrorBody = { error: 'Conflict', code: outcome.code };
        res.status(409).json(conflict);
        return;
      }

      await auditCommitted(itemId, () =>
        auditLogger.recordApi(actor, project, 'review_queue.approve', outcome.audit),
      );
      res.status(200).json(outcome.dto);
    },
  );

  router.post(
    '/review-queue/:itemId/reject',
    async (req: Request<ItemParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const itemId = parseItemId(req.params.itemId);
      const body = parseOrInvalid(RejectBody, req.body ?? {});

      const outcome = await reviewService.reject(actor, project.projectId, itemId, body);
      if (outcome.kind === 'invalid_reason') throw new AppError(ErrorCode.INVALID_REQUEST);
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);

      await auditCommitted(itemId, () =>
        auditLogger.recordApi(actor, project, 'review_queue.reject', {
          itemId,
          decision: 'rejected',
        }),
      );
      res.status(200).json(outcome.dto);
    },
  );

  return router;
}
