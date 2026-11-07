/**
 * ⚠️  DEV-ONLY GATE-1 STUB — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DevAuthenticator bypasses Cognito entirely and returns a FIXED Principal
 * regardless of the Authorization header (the arg is intentionally ignored).
 * It is chosen at the composition root ONLY when AUTH_DEV_BYPASS=true AND
 * NODE_ENV !== 'production'. config.loadConfig() fails fast if that pairing is
 * ever attempted in production, so this class can never run there.
 *
 * The returned `subject` MUST equal the seeded app_user.idp_subject in
 * migrations/seed.dev.sql, otherwise the REAL Gate 2 (RdsAuthorizer) denies
 * every request. Everything downstream (tenant resolve, RBAC, audit) is REAL.
 *
 * // DEV-ONLY
 */
import type { Authenticator, Principal } from '../mcp/context.js';

/** Fixed identity — kept in lockstep with migrations/seed.dev.sql. */
export const DEV_PRINCIPAL: Principal = {
  subject: 'dev-local-user', // == app_user.idp_subject (seed)
  clientId: 'dev-local-client', // not consumed by Gate 2 / RBAC
  scopes: ['lpms.memory/read'], // representative; Authorizer ignores scopes
};

export class DevAuthenticator implements Authenticator {
  async authenticate(_authorization: string | undefined): Promise<Principal> {
    // No token verification. Returns the fixed dev principal unconditionally.
    return DEV_PRINCIPAL;
  }
}
