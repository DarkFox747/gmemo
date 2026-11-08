/**
 * GET /v1/me — the authenticated user and the non-archived projects they
 * belong to, with role. No project content. Audited as `me.read` (project null)
 * after success; Gate-2 failures are opaque 404s and never audited.
 */

import express from 'express';
import type { Request } from 'express';
import type { ActorIdentity } from '../../mcp/context.js';
import type { ApiResponse, ApiRouterDeps, MeDto } from './types.js';

export function makeMeRouter(
  deps: Pick<ApiRouterDeps, 'authorizer' | 'authRepository' | 'auditLogger'>,
): express.Router {
  const router = express.Router();

  router.get('/v1/me', async (_req: Request, res: ApiResponse): Promise<void> => {
    const user = await deps.authorizer.authorizeUser(res.locals.principal);
    const projects = await deps.authRepository.listProjectsForUser(user.userId);

    const actor: ActorIdentity = {
      actorId: user.actorId,
      userId: user.userId,
      roles: user.globalRole ? [user.globalRole] : [],
    };
    await deps.auditLogger.recordApi(actor, null, 'me.read');

    const body: MeDto = {
      user: { id: user.userId, email: user.email, displayName: user.displayName },
      projects: projects.map((p) => ({
        id: p.projectId,
        slug: p.slug,
        name: p.name,
        role: p.role,
      })),
    };
    res.status(200).json(body);
  });

  return router;
}
