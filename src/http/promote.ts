/**
 * POST /promote handler factory.
 *
 * Mirrors the opacity model of makeMcpPostHandler: all errors are forwarded
 * via next(err) to the terminal error handler which returns a generic opaque
 * 500 — no tenant/resource/stack detail ever leaves the server.
 *
 * Handler chain (design.md §"POST /promote — handler + wiring"):
 *  1. Zod-parse + validate body (bad body → PERMISSION_DENIED, NOT a schema echo)
 *  2. oidcVerifier.verify(Authorization) → PromotePrincipal
 *  3. Assert body.repo === principal.repository (token claim is authoritative)
 *  4. authRepository.findRepoByGithubSlug(principal.repository) → RepoResolution
 *     (null → PERMISSION_DENIED — opaque, no oracle)
 *  5. Build TenantContext from resolution + source_branch
 *  6. authorizer.authorizePromote(principal, tenant) → ActorIdentity
 *  7. promotionRepository.findOpenSessionId(tenant) → sessionId | null
 *     (null → 200 no_op)
 *  8. promoteService.promote(sessionId, meta) → PromoteOutcome
 *  9. res.status(200).json(outcome)
 */

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors/appError.js';
import type { AppServices, TenantContext } from '../mcp/context.js';

// ---------------------------------------------------------------------------
// Request body schema — strict (rejects unknown keys)
// ---------------------------------------------------------------------------

const PromoteBody = z
  .object({
    repo: z.string().min(1),
    source_branch: z.string().min(1),
    pr_number: z.number().int().positive().optional(),
    merge_sha: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function makePromoteHandler(
  services: AppServices,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Step 1: Parse + validate body.
      // Failures throw PERMISSION_DENIED — never echo schema details to the caller.
      const bodyResult = PromoteBody.safeParse(req.body);
      if (!bodyResult.success) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      const body = bodyResult.data;

      // Step 2: Verify OIDC token → PromotePrincipal { repository, ref }.
      const principal = await services.oidcVerifier.verify(req.headers.authorization);

      // Step 3: Token claim is authoritative over the body.
      if (body.repo !== principal.repository) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Step 3.5: Enforce the OIDC ref claim against the requested source branch.
      // The token's `ref` is the authoritative signal for which branch the CI workflow
      // ran on. Strip the full-ref prefix (GitHub tokens use 'refs/heads/<branch>')
      // and assert it matches body.source_branch so a credential cannot target an
      // arbitrary branch's staging session.
      const canonicalRef = principal.ref.replace(/^refs\/heads\//, '');
      if (canonicalRef !== body.source_branch) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Step 4: Resolve tenant from the GitHub slug carried by the token.
      const repoResolution = await services.authRepository.findRepoByGithubSlug(
        principal.repository,
      );
      if (!repoResolution) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Step 4a: Enforce that promotion only originates from the repo's default
      // branch.  A valid OIDC token minted on a feature branch must not be able
      // to promote that branch's staged items into authoritative memory —
      // promotion is exclusively a PR-merge-to-default-branch operation.
      if (body.source_branch !== repoResolution.defaultBranch) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Step 5: Build TenantContext — branch is the promotion source branch.
      const tenant: TenantContext = {
        projectId: repoResolution.projectId,
        repoId: repoResolution.repoId,
        branch: body.source_branch,
      };

      // Step 6: Authorize the machine credential (machine_credential path; not app_user).
      const actor = await services.authorizer.authorizePromote(principal, tenant);

      // Step 7: Find the open staging session for this tenant + branch.
      const sessionId = await services.promotionRepository.findOpenSessionId(tenant);
      if (!sessionId) {
        // No open session — idempotent no-op (branch has nothing staged).
        res.status(200).json({ status: 'no_op', applied: 0, deduped: 0, quarantined: 0, uncertain: 0 });
        return;
      }

      // Step 8: Run the promotion state machine.
      const outcome = await services.promoteService.promote(sessionId, {
        tenant,
        actor,
        originBranch: body.source_branch,
        originPr: body.pr_number ?? null,
        mergeSha: body.merge_sha ?? null,
      });

      // Step 9: Return the outcome.
      res.status(200).json(outcome);
    } catch (err) {
      // Forward to the terminal error handler only if headers have not been sent.
      // Never leak internal detail (identical opacity to makeMcpPostHandler).
      if (!res.headersSent) {
        next(err);
      }
    }
  };
}
