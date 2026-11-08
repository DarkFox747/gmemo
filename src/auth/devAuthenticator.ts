/**
 * ⚠️  DEV-ONLY GATE-1 STUB — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DevAuthenticator bypasses Cognito entirely; the Authorization header is
 * intentionally ignored. It is chosen at the composition root ONLY when
 * AUTH_DEV_BYPASS=true AND NODE_ENV !== 'production'. config.loadConfig()
 * fails fast if that pairing is ever attempted in production, and this class
 * also refuses to construct or authenticate under NODE_ENV=production
 * (third layer of the C2 production guard, design D1).
 *
 * Dev-user selection (C2): when `opts.devUser` is present (the REST layer
 * forwards X-Dev-User), the email is trimmed, lowercased and validated, then
 * resolved to an EXISTING ENABLED app_user via the repository. Unknown,
 * disabled, malformed or empty values are denied (PERMISSION_DENIED). The
 * returned subject then flows through the REAL Gate 2, so a dev login can
 * only become a seeded, enabled user with that user's real memberships.
 *
 * When `opts.devUser` is absent, the fixed DEV_PRINCIPAL is returned. Its
 * subject MUST equal the seeded app_user.idp_subject in migrations/seed.dev.sql.
 *
 * The email is never logged.
 *
 * // DEV-ONLY
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors/appError.js';
import type { AuthRepository } from '../db/authRepository.js';
import type { AuthenticateOptions, Authenticator, Principal } from '../mcp/context.js';

/** Fixed identity — kept in lockstep with migrations/seed.dev.sql. */
export const DEV_PRINCIPAL: Principal = {
  subject: 'dev-local-user', // == app_user.idp_subject (seed)
  clientId: 'dev-local-client', // not consumed by Gate 2 / RBAC
  scopes: ['gmemo.memory/read'], // representative; Authorizer ignores scopes
};

const DevUserEmail = z.string().email().max(254);

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export class DevAuthenticator implements Authenticator {
  constructor(private readonly users: Pick<AuthRepository, 'findEnabledUserByEmail'>) {
    if (isProduction()) {
      throw new Error(
        '[auth] DevAuthenticator must never be constructed under NODE_ENV=production',
      );
    }
  }

  async authenticate(
    _authorization: string | undefined,
    opts?: AuthenticateOptions,
  ): Promise<Principal> {
    if (isProduction()) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }

    const devUser = opts?.devUser;
    if (devUser === undefined) {
      return DEV_PRINCIPAL;
    }

    const parsed = DevUserEmail.safeParse(devUser.trim().toLowerCase());
    if (!parsed.success) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }

    let user: { userId: string; idpSubject: string } | null;
    try {
      user = await this.users.findEnabledUserByEmail(parsed.data);
    } catch (err) {
      // Same opaque denial as an unknown user; cause kept for server-side diagnostics.
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
    if (!user) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }

    return {
      subject: user.idpSubject,
      clientId: DEV_PRINCIPAL.clientId,
      scopes: DEV_PRINCIPAL.scopes,
    };
  }
}
