/**
 * Tenant resolution: X-Git-Remote → repo row → TenantContext.
 *
 * RdsTenantResolver looks up the repo by its remote URL (the natural tenant
 * key supplied by the client via the X-Git-Remote header). A missing header
 * or an unregistered remote both map to AppError(PERMISSION_DENIED) — the
 * caller cannot tell whether a remote is unknown vs. registered but denied,
 * preventing a project-existence oracle (design §4: no tenant enumeration).
 *
 * `branch` falls back to the repo's default_branch when the client omits
 * X-Git-Branch.
 */

import { AppError, ErrorCode } from '../errors/appError.js';
import type { AuthRepository } from '../db/authRepository.js';
import type {
  TenantContext,
  TenantResolutionInput,
  TenantResolver,
} from '../mcp/context.js';

export class RdsTenantResolver implements TenantResolver {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Resolves the TenantContext from the per-request header inputs.
   *
   * @throws AppError(PERMISSION_DENIED) when X-Git-Remote is absent or
   *   the remote URL is not registered — indistinguishable to the caller.
   */
  async resolve(input: TenantResolutionInput): Promise<TenantContext> {
    try {
      if (!input.gitRemote) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      const result = await this.repo.findRepoByRemoteUrl(input.gitRemote);
      if (!result) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      return {
        projectId: result.projectId,
        repoId: result.repoId,
        branch: input.branch ?? result.defaultBranch,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
  }
}
