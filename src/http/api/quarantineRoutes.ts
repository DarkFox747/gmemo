/**
 * Quarantine routes (C3, HU-10), mounted at /v1/projects/:projectId/quarantine
 * behind makeProjectMember (any project member passes Gate 2).
 *
 *   GET  /                 list (admin: all rows; others: own rows)  → quarantine.list
 *   GET  /:id              detail (admin or author, else 404)        → quarantine.read
 *   POST /:id/restore      restore (project_admin only, else 404)    → quarantine.restore
 *
 * Validation order: projectMember → uuid :id → role (restore) → JSON content
 * type → zod, so a non-admin with a bad body gets 404, not 400. Reads are
 * audited after success; denials are never audited. The restore's audit row is
 * written in the restored item's terminal write transaction (C11): an audit
 * failure rolls that write back and is a 500.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { QUARANTINE_REASON_CODES } from '../../quarantine/reason.js';
import type { ProjectContext, ProjectMember } from '../../mcp/context.js';
import type { ApiResponse, ApiRouterDeps } from './types.js';

const QuarantineQuery = z
  .object({
    reason: z.enum(QUARANTINE_REASON_CODES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const RestoreBody = z.object({}).strict();

const QuarantineId = z.string().uuid();

const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

type IdParams = { projectId: string; id: string };

/** projectMember always sets these; their absence is a wiring bug, not a client error. */
function memberContext(res: ApiResponse): { member: ProjectMember; project: ProjectContext } {
  const { member, project } = res.locals;
  if (!member || !project) throw new AppError(ErrorCode.INTERNAL);
  return { member, project };
}

/** Malformed ids get the same 404 as a missing row. */
function parseId(raw: string): string {
  const parsed = QuarantineId.safeParse(raw);
  if (!parsed.success) throw new AppError(ErrorCode.NOT_FOUND);
  return parsed.data;
}

function parseOrInvalid<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError(ErrorCode.INVALID_REQUEST);
  return parsed.data;
}

export function makeQuarantineRouter(
  deps: Pick<ApiRouterDeps, 'quarantineService' | 'auditLogger'>,
): express.Router {
  const { quarantineService, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/', async (req: Request, res: ApiResponse): Promise<void> => {
    const { member, project } = memberContext(res);
    const q = parseOrInvalid(QuarantineQuery, req.query);

    const dto = await quarantineService.list(member, project.projectId, {
      reason: q.reason ?? null,
      limit: q.limit,
    });
    await auditLogger.recordApi(member, project, 'quarantine.list', {
      filter: q.reason,
      resultCount: dto.items.length,
    });
    res.status(200).json(dto);
  });

  router.get('/:id', async (req: Request<IdParams>, res: ApiResponse): Promise<void> => {
    const { member, project } = memberContext(res);
    const id = parseId(req.params.id);

    const dto = await quarantineService.get(member, project.projectId, id);
    if (!dto) throw new AppError(ErrorCode.NOT_FOUND);

    await auditLogger.recordApi(member, project, 'quarantine.read', { quarantineId: id });
    res.status(200).json(dto);
  });

  router.post('/:id/restore', async (req: Request<IdParams>, res: ApiResponse): Promise<void> => {
    const { member, project } = memberContext(res);
    const id = parseId(req.params.id);
    // Admin-only, checked before the body is looked at (no validation oracle).
    if (member.projectRole !== 'project_admin') throw new AppError(ErrorCode.NOT_FOUND);
    // State-changing POSTs must be JSON (blocks form-encoded cross-site posts).
    if (!JSON_CONTENT_TYPE.test(req.get('content-type') ?? '')) {
      throw new AppError(ErrorCode.INVALID_REQUEST);
    }
    parseOrInvalid(RestoreBody, req.body ?? {});

    const outcome = await quarantineService.restore(
      member,
      project.projectId,
      id,
      auditLogger.apiWriteAudit(member, project, 'quarantine.restore'),
    );
    if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);
    res.status(200).json(outcome.dto);
  });

  // Nothing under /quarantine falls through to other project routers.
  router.use(() => {
    throw new AppError(ErrorCode.NOT_FOUND);
  });

  return router;
}
