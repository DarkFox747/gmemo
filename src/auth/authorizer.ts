/**
 * Gate 2 + RBAC: RDS-authoritative authorization.
 *
 * RdsAuthorizer enforces two sequential checks before any read proceeds:
 *
 *  1. The JWT subject maps to a provisioned AND enabled app_user row
 *     (disabled_at IS NULL). Absent and disabled users are indistinguishable
 *     to prevent a user-existence oracle.
 *
 *  2. A project_membership row exists for (projectId, userId). No membership
 *     means no access, even for users with a platform-level global_role
 *     (design decision D4: global roles still require membership for reads).
 *
 * On success the method returns ActorIdentity derived entirely from RDS
 * — not from token claims — satisfying the "prefer RDS roles" requirement.
 * The actorId is set to principal.subject (the JWT `sub`), which matches
 * the app_user.idp_subject stable identifier stored in access_log.
 *
 * The machine/service-agent path is deliberately absent (fail-CLOSED):
 * no code here consults machine_credential. A non-Cognito bearer secret
 * fails Gate 1 before reaching this class.
 *
 * All denials are opaque (AppError PERMISSION_DENIED with the same generic
 * message regardless of which check failed).
 */

import { AppError, ErrorCode } from '../errors/appError.js';
import type { AuthRepository } from '../db/authRepository.js';
import type { PromotePrincipal } from './oidcAuthenticator.js';
import type {
  ActorIdentity,
  Authorizer,
  Principal,
  TenantContext,
  ToolName,
} from '../mcp/context.js';

// Hoisted to module scope (L4): allocated once, not per authorize() call.
// Write tools require a writer-level membership role; reads check only membership existence.
// Atomic with ToolName widening — both must land together to prevent an
// auth hole where a viewer-with-membership passes the write gate.
const WRITE_TOOLS: ReadonlySet<ToolName> =
  new Set(['remember', 'list_staged', 'discard_staged']);
const WRITE_ROLES: ReadonlySet<string> =
  new Set(['project_admin', 'contributor', 'service_agent']);

export class RdsAuthorizer implements Authorizer {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Runs Gate 2 and RBAC checks, returning the actor's RDS-derived identity.
   *
   * @throws AppError(PERMISSION_DENIED) when the user is absent, disabled,
   *   or has no project_membership row — all cases are byte-identical to
   *   the caller.
   */
  async authorize(
    principal: Principal,
    tenant: TenantContext,
    tool: ToolName,
  ): Promise<ActorIdentity> {
    try {
      // Gate 2: user must be provisioned AND enabled.
      const user = await this.repo.findEnabledUserBySubject(principal.subject);
      if (!user) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // RBAC: membership row is mandatory for all tools (D4).
      const membershipRole = await this.repo.findMembershipRole(
        tenant.projectId,
        user.userId,
      );
      if (!membershipRole) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Write-gate: write tools require a writer-level membership role.
      // Reads keep the membership-existence check only (no role enforcement).
      if (WRITE_TOOLS.has(tool) && !WRITE_ROLES.has(membershipRole)) {
        throw new AppError(ErrorCode.PERMISSION_DENIED); // viewer denied, opaque
      }

      // Roles come exclusively from RDS (not token claims).
      // Include global_role first when present; membership role always last.
      const roles: string[] = [];
      if (user.globalRole) {
        roles.push(user.globalRole);
      }
      roles.push(membershipRole);

      return {
        actorId: principal.subject,
        roles,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
  }

  /**
   * Machine path for POST /promote — checks machine_credential (Decision 3).
   * Does NOT route through the app_user + project_membership path; CI/OIDC
   * principals have no rows in those tables.
   *
   * @throws AppError(PERMISSION_DENIED) when no active credential exists —
   *   identical message regardless of which check failed (opaque; no oracle).
   */
  async authorizePromote(
    principal: PromotePrincipal,
    tenant: TenantContext,
  ): Promise<ActorIdentity> {
    try {
      const cred = await this.repo.findActiveMachineCredential(
        tenant.projectId,
        principal.repository,
      );
      if (!cred) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      return {
        actorId: principal.repository,
        roles: [cred.role],
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
  }
}
