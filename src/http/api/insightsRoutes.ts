/**
 * Governance insight routes (C12), mounted on the nested
 * /v1/projects/:projectId router behind makeProjectAdmin:
 *
 *   GET /dashboard   Inicio: counts + judge section (30 days)   → dashboard.read
 *   GET /activity    Actividad: audit timeline (keyset cursor)  → activity.list
 *   GET /staging     Área de preparación: staging sessions      → staging.list
 *
 * Read-only. Query strings are validated with strict schemas after
 * authorization, so a non-admin always gets the opaque 404 and an admin with an
 * unknown, repeated or out-of-range key gets 400 without echo. Audit runs only
 * after success and carries counters or the status filter only.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { parseActivityCursor } from '../../db/insightsMapping.js';
import { adminContext, parseOrInvalid } from './reviewRoutes.js';
import type { ApiResponse, ApiRouterDeps } from './types.js';

/** Digits only: rejects 1e1, 0x10, ' 5', '-1' and '' that z.coerce.number would accept. */
const limitParam = (max: number, fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .default(String(fallback));

const NoQuery = z.object({}).strict();

const ActivityQuery = z
  .object({
    category: z.enum(['staging', 'promotion', 'review', 'quarantine', 'memory', 'jobs']).optional(),
    cursor: z
      .string()
      .refine((c) => parseActivityCursor(c) !== null)
      .optional(),
    limit: limitParam(100, 50),
  })
  .strict();

const StagingQuery = z
  .object({
    status: z.enum(['open', 'closed']).default('open'),
    limit: limitParam(50, 20),
  })
  .strict();

export function makeInsightsRoutes(
  deps: Pick<ApiRouterDeps, 'insightsRepository' | 'auditLogger'>,
): express.Router {
  const { insightsRepository, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/dashboard', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    parseOrInvalid(NoQuery, req.query);

    const dto = await insightsRepository.getDashboard(project.projectId);

    await auditLogger.recordApi(actor, project, 'dashboard.read');
    res.status(200).json(dto);
  });

  router.get('/activity', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    // A repeated key arrives as an array and fails the string/enum schema.
    const q = parseOrInvalid(ActivityQuery, req.query);

    const dto = await insightsRepository.listActivity(project.projectId, {
      category: q.category ?? null,
      cursor: q.cursor ?? null,
      limit: q.limit,
    });

    await auditLogger.recordApi(actor, project, 'activity.list', {
      resultCount: dto.items.length,
    });
    res.status(200).json(dto);
  });

  router.get('/staging', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    const q = parseOrInvalid(StagingQuery, req.query);

    const dto = await insightsRepository.listStaging(project.projectId, q);

    await auditLogger.recordApi(actor, project, 'staging.list', {
      status: q.status,
      resultCount: dto.sessions.length,
    });
    res.status(200).json(dto);
  });

  return router;
}
