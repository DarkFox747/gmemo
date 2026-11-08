/**
 * ⚠️  DEV-ONLY OIDC STUB — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DevOidcAuthenticator bypasses GitHub OIDC verification entirely and returns
 * a FIXED repository regardless of the Authorization header (the arg is
 * intentionally ignored). The ref defaults to 'refs/heads/main' and can be
 * overridden with `opts.devRef` (the /promote handler passes
 * 'refs/heads/<source_branch>' so the closed_unmerged demo works locally);
 * headRef is always null. It is chosen at the composition root ONLY when
 * PROMOTE_OIDC_DEV_BYPASS=true AND NODE_ENV !== 'production'. config.loadConfig()
 * fails fast if that pairing is ever attempted in production, so this class can
 * never run there.
 *
 * The returned `repository` MUST equal the `principal_name` seeded in
 * migrations/seed.dev.sql for the machine_credential row, otherwise
 * authorizePromote (machine_credential lookup) will deny every request.
 * Everything downstream (tenant resolve, RBAC, audit, promotion) is REAL.
 *
 * // DEV-ONLY
 */
import type { OidcVerifier, OidcVerifyOptions, PromotePrincipal } from './oidcAuthenticator.js';

/**
 * Fixed identity — kept in lockstep with migrations/seed.dev.sql
 * (machine_credential.principal_name) and the repo row's remote_url
 * (https://github.com/crombie-llc/gmemo-demo.git).
 */
export const DEV_PROMOTE_PRINCIPAL: PromotePrincipal = {
  repository: 'crombie-llc/gmemo-demo', // == machine_credential.principal_name (seed)
  ref: 'refs/heads/main',
  headRef: null,
};

export class DevOidcAuthenticator implements OidcVerifier {
  async verify(
    _authorization: string | undefined,
    opts?: OidcVerifyOptions,
  ): Promise<PromotePrincipal> {
    // No token verification. Fixed dev repository; ref overridable via devRef.
    return { ...DEV_PROMOTE_PRINCIPAL, ref: opts?.devRef ?? DEV_PROMOTE_PRINCIPAL.ref };
  }
}
