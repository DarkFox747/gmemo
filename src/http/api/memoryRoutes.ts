/**
 * Project memory routes, mounted on the nested /v1/projects/:projectId router
 * behind makeProjectAdmin — so a non-admin never reaches validation and gets the
 * same opaque 404.
 *
 * Direct management (C5, HU-13):
 *   GET  /memories                      list (status/type/q/cursor)  → memories.list
 *   POST /memories/preview              pipeline + judge, no write   → memory.preview
 *   GET  /memories/:memoryId            detail + revision history    → memory.read
 *   POST /memories                      confirmed add                → memory.create
 *   PUT  /memories/:memoryId            confirmed amend              → memory.amend
 * Lifecycle (C4, HU-12.2, HU-12.3, HU-11.4):
 *   POST /memories/retire-by-pr         bulk retire by origin PR     → memory.retire_by_pr
 *   POST /memories/:memoryId/confirm    pending → active             → memory.confirm
 *   POST /memories/:memoryId/retire     active|pending → deprecated  → memory.retire
 *
 * Order: projectAdmin → JSON content type on POST/PUT → uuid :memoryId (else 404)
 * → zod (else 400) → service. not_found (absent, foreign, wrong status, repeat)
 * is the uniform 404; a stale or inactive amend target is a 409 with its code;
 * an add that dedups onto a non-active memory is 409 duplicate_inactive; a
 * confirm whose judge or judge context failed closed is 503
 * evaluation_unavailable (nothing applied, session abandoned).
 * Reads are audited after success and audits never carry content (a list
 * search is stored as its hash). A write's audit row is bound here and written
 * in the write's own transaction (C11): an audit failure rolls the write back
 * and is a 500.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { MEMORY_TYPES } from '../../mcp/tools/schemas.js';
import { assertValidFields } from '../../mcp/fieldsPolicy.js';
import { sha256Hex } from '../../security/hash.js';
import type { MemoryType } from '../../contracts/memory.js';
import type { ApiAuditDetail } from '../../mcp/context.js';
import type { PreviewInput, UnitInput } from '../../memory/types.js';
import { adminContext, parseOrInvalid, requireJsonContentType } from './reviewRoutes.js';
import type { ApiErrorBody, ApiResponse, ApiRouterDeps, ConflictCode } from './types.js';

export const MemoryListQuery = z
  .object({
    status: z
      .enum(['active', 'pending_revalidation', 'superseded', 'deprecated'])
      .default('active'),
    type: z.enum(MEMORY_TYPES).optional(),
    // '' after trim is treated as absent.
    q: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
  })
  .strict();

/** Fields budget (as remember / the DB CHECK) and the per-type key policy → 400. */
function fieldsRefine(
  u: { type: MemoryType; fields: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  if (JSON.stringify(u.fields).length > 2000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid' });
  }
  try {
    assertValidFields(u.type, u.fields);
  } catch (err) {
    // assertValidFields throws INVALID_REFERENCE (a REST 404); for the admin it is a 400.
    if (!(err instanceof AppError)) throw err;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid' });
  }
}

/** Budgets identical to rememberInputShape / the DB CHECK constraints. */
const Unit = {
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  fields: z.record(z.unknown()).default({}),
  repoId: z.string().uuid().optional(),
};

/** A JSON number: "3", 0, -1 and 1.5 are all 400. */
const Revision = z.number().int().positive();

export const CreateBody = z
  .object({ ...Unit, confirm: z.literal(true) })
  .strict()
  .superRefine(fieldsRefine);

export const AmendBody = z
  .object({ ...Unit, expectedRevision: Revision, confirm: z.literal(true) })
  .strict()
  .superRefine(fieldsRefine);

export const PreviewBody = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('add'), ...Unit }).strict(),
    z
      .object({
        op: z.literal('amend'),
        ...Unit,
        targetMemoryId: z.string().uuid(),
        expectedRevision: Revision,
      })
      .strict(),
  ])
  .superRefine(fieldsRefine);

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

function toUnit(b: Omit<UnitInput, 'repoId'> & { repoId?: string }): UnitInput {
  return {
    type: b.type,
    title: b.title,
    summary: b.summary,
    body: b.body,
    fields: b.fields,
    repoId: b.repoId ?? null,
  };
}

/**
 * Non-success service outcomes: not_found → 404, invalid → 400, conflict → 409,
 * unavailable → 503 evaluation_unavailable (SEC-M2: the judge or its context
 * failed closed; nothing applied). The caller is already proven project_admin.
 */
function failOutcome(
  o:
    | { kind: 'not_found' }
    | { kind: 'invalid' }
    | { kind: 'conflict'; code: ConflictCode }
    | { kind: 'unavailable' },
  res: ApiResponse,
): void {
  if (o.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);
  if (o.kind === 'invalid') throw new AppError(ErrorCode.INVALID_REQUEST);
  if (o.kind === 'unavailable') {
    const body: ApiErrorBody = { error: 'Service unavailable', code: 'evaluation_unavailable' };
    res.status(503).json(body);
    return;
  }
  const conflict: ApiErrorBody = { error: 'Conflict', code: o.code };
  res.status(409).json(conflict);
}

export function makeMemoryRoutes(
  deps: Pick<ApiRouterDeps, 'lifecycleService' | 'directMemoryService' | 'auditLogger'>,
): express.Router {
  const { lifecycleService, directMemoryService, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/memories', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    const parsed = parseOrInvalid(MemoryListQuery, req.query);
    const q = parsed.q !== undefined && parsed.q.length > 0 ? parsed.q : null;

    const dto = await directMemoryService.list(project.projectId, {
      status: parsed.status,
      type: parsed.type ?? null,
      q,
      cursor: parsed.cursor ?? null,
      limit: parsed.limit,
    });
    const detail: ApiAuditDetail = {
      status: parsed.status,
      type: parsed.type,
      resultCount: dto.items.length,
    };
    // Same normalisation as the MCP recall wrapper; the raw text is never audited.
    if (q !== null) detail.queryHash = sha256Hex(q.toLowerCase());
    await auditLogger.recordApi(actor, project, 'memories.list', detail);
    res.status(200).json(dto);
  });

  router.post(
    '/memories/preview',
    requireJsonContentType,
    async (req: Request, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const body = parseOrInvalid(PreviewBody, req.body ?? {});
      const unit = toUnit(body);
      const input: PreviewInput =
        body.op === 'amend'
          ? {
              ...unit,
              op: 'amend',
              targetMemoryId: body.targetMemoryId,
              expectedRevision: body.expectedRevision,
            }
          : { ...unit, op: 'add' };

      const outcome = await directMemoryService.preview(actor, project.projectId, input);
      if (outcome.kind !== 'ok') {
        failOutcome(outcome, res);
        return;
      }
      await auditLogger.recordApi(actor, project, 'memory.preview', outcome.audit);
      res.status(200).json(outcome.dto);
    },
  );

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
        auditLogger.apiWriteAudit(actor, project, 'memory.retire_by_pr'),
      );
      if (outcome.kind === 'invalid_reason') throw new AppError(ErrorCode.INVALID_REQUEST);
      res.status(200).json(outcome.dto);
    },
  );

  router.get(
    '/memories/:memoryId',
    async (req: Request<MemoryParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const memoryId = parseMemoryId(req.params.memoryId);

      const dto = await directMemoryService.get(project.projectId, memoryId);
      if (!dto) throw new AppError(ErrorCode.NOT_FOUND);

      await auditLogger.recordApi(actor, project, 'memory.read', { memoryId });
      res.status(200).json(dto);
    },
  );

  router.post(
    '/memories',
    requireJsonContentType,
    async (req: Request, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const body = parseOrInvalid(CreateBody, req.body ?? {});

      const outcome = await directMemoryService.create(
        actor,
        project.projectId,
        toUnit(body),
        auditLogger.apiWriteAudit(actor, project, 'memory.create'),
      );
      if (outcome.kind !== 'done') {
        failOutcome(outcome, res);
        return;
      }
      res.status(200).json(outcome.dto);
    },
  );

  router.put(
    '/memories/:memoryId',
    requireJsonContentType,
    async (req: Request<MemoryParams>, res: ApiResponse): Promise<void> => {
      const { actor, project } = adminContext(res);
      const memoryId = parseMemoryId(req.params.memoryId);
      const body = parseOrInvalid(AmendBody, req.body ?? {});

      const outcome = await directMemoryService.amend(
        actor,
        project.projectId,
        memoryId,
        { ...toUnit(body), expectedRevision: body.expectedRevision },
        auditLogger.apiWriteAudit(actor, project, 'memory.amend'),
      );
      if (outcome.kind !== 'done') {
        failOutcome(outcome, res);
        return;
      }
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

      const outcome = await lifecycleService.confirm(
        actor,
        project.projectId,
        memoryId,
        auditLogger.apiWriteAudit(actor, project, 'memory.confirm'),
      );
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);
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
        auditLogger.apiWriteAudit(actor, project, 'memory.retire'),
      );
      if (outcome.kind === 'invalid_reason') throw new AppError(ErrorCode.INVALID_REQUEST);
      if (outcome.kind === 'not_found') throw new AppError(ErrorCode.NOT_FOUND);
      res.status(200).json(outcome.dto);
    },
  );

  return router;
}
