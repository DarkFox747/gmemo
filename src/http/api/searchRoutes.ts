/**
 * Search explorer route (C13, "Buscar como agente"), mounted on the nested
 * /v1/projects/:projectId router behind makeProjectAdmin:
 *
 *   GET /search?q=&types=&limit=&repoId=   what an agent's recall returns → memories.search
 *
 * Ranks with rankActiveMemories — the same function MCP recall uses (one search
 * code path): active memories only, RRF k=60, repo priority only when a repoId
 * is given. Project scope, first page only (no cursor), no staged drafts.
 *
 * Order: projectAdmin (non-admin → opaque 404 before validation) → strict zod
 * query (unknown or repeated key → 400) → repoId must belong to the project
 * (else the uniform 404) → rank → audit → 200. X-Git-Remote / X-Git-Branch are
 * never read. An embedder failure is not an error: 200 with semantic
 * 'unavailable'. The audit carries the result count and the query hash
 * (same normalisation as recall) — never the raw query or the repo id.
 */

import express from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { MEMORY_TYPES } from '../../mcp/tools/schemas.js';
import { sha256Hex } from '../../security/hash.js';
import { rankActiveMemories } from '../../search/hybridSearch.js';
import { adminContext, parseOrInvalid } from './reviewRoutes.js';
import { limitParam } from './insightsRoutes.js';
import type { ApiResponse, ApiRouterDeps, SearchResponseDto } from './types.js';

export const SearchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    // CSV ("decision,gotcha"), deduplicated; '' or an unknown type → 400.
    types: z
      .string()
      .max(200)
      .transform((s) => [...new Set(s.split(','))])
      .pipe(z.array(z.enum(MEMORY_TYPES)).min(1))
      .optional(),
    limit: limitParam(8, 5),
    repoId: z.string().uuid().optional(),
  })
  .strict();

export function makeSearchRoutes(
  deps: Pick<
    ApiRouterDeps,
    'memoryRepository' | 'embedder' | 'memoryAdminRepository' | 'auditLogger'
  >,
): express.Router {
  const { memoryRepository, embedder, memoryAdminRepository, auditLogger } = deps;
  const router = express.Router({ mergeParams: true });

  router.get('/search', async (req: Request, res: ApiResponse): Promise<void> => {
    const { actor, project } = adminContext(res);
    const q = parseOrInvalid(SearchQuery, req.query);

    // Only look the repo up when one was given: findProjectRepoId(p, null)
    // falls back to the project's first repo, which would be an invisible boost.
    let repoId: string | null = null;
    if (q.repoId !== undefined) {
      repoId = await memoryAdminRepository.findProjectRepoId(project.projectId, q.repoId);
      if (repoId === null) throw new AppError(ErrorCode.NOT_FOUND);
    }

    const { ranked, semantic } = await rankActiveMemories(
      { memoryRepository, embedder },
      { projectId: project.projectId, repoId },
      { query: q.q, scope: 'project', types: q.types },
    );

    const dto: SearchResponseDto = {
      items: ranked.slice(0, q.limit).map((f, index) => ({
        position: index + 1,
        id: f.row.id,
        type: f.row.type,
        title: f.row.title,
        summary: f.row.summary,
        repoId: f.row.repo_id ?? null,
        version: f.row.current_revision,
        updatedAt: f.row.updated_at.toISOString(),
        score: f.score,
        lexicalRank: f.lexicalRank,
        semanticRank: f.semanticRank,
      })),
      totalCandidates: ranked.length,
      semantic,
      repoId,
    };

    // Same normalisation as the MCP recall wrapper; the raw text is never audited.
    await auditLogger.recordApi(actor, project, 'memories.search', {
      resultCount: dto.items.length,
      queryHash: sha256Hex(q.q.toLowerCase()),
    });
    res.status(200).json(dto);
  });

  return router;
}
