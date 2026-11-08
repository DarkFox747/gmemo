/**
 * OIDC seam for POST /promote.
 *
 * GithubOidcAuthenticator verifies a GitHub Actions OIDC JWT against
 * token.actions.githubusercontent.com's JWKS, validating aud, iss, exp, nbf,
 * and RSA signature, then extracts the repository, ref, head_ref, event_name and
 * job_workflow_ref claims into a
 * PromotePrincipal.
 *
 * The underlying JWKS verifier is injected at construction time (one instance
 * per process, built at the composition root in src/index.ts when
 * PROMOTE_OIDC_DEV_BYPASS is false). This mirrors the CognitoAuthenticator
 * pattern: per-call construction would defeat the in-process JWKS cache that
 * handles key rotation.
 *
 * Verify is fail-closed: ANY failure — bad signature, wrong iss/aud, expired,
 * missing claim, or any throw from the underlying verifier — maps opaquely to
 * AppError(PERMISSION_DENIED). No enumeration of why.
 */

import { AppError, ErrorCode } from '../errors/appError.js';

// ---------------------------------------------------------------------------
// GitHub OIDC well-known constants (fixed by GitHub's platform, not per-env)
// ---------------------------------------------------------------------------

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Claims extracted from the GitHub Actions OIDC token for the /promote path. */
export interface PromotePrincipal {
  /** GitHub slug of the repository that minted the token (e.g. 'org/repo'). */
  repository: string;
  /** Git ref the workflow is running on (e.g. 'refs/heads/main'). */
  ref: string;
  /**
   * PR head branch (GitHub `head_ref` claim, set only for pull_request
   * workflows). null when absent or empty.
   */
  headRef: string | null;
  /**
   * Event that triggered the workflow (GitHub `event_name` claim, e.g. 'push',
   * 'pull_request_target', 'workflow_dispatch'). null when absent or empty.
   */
  eventName: string | null;
  /**
   * Workflow file + ref of the job that minted the token (GitHub
   * `job_workflow_ref` claim, e.g. 'org/repo/.github/workflows/promote.yml@refs/heads/main').
   * null when absent or empty.
   */
  jobWorkflowRef: string | null;
}

/** Options for OidcVerifier.verify. */
export interface OidcVerifyOptions {
  /** DEV ONLY. Honoured by DevOidcAuthenticator; every other implementation MUST ignore it. */
  devRef?: string;
}

/**
 * Narrow seam over OIDC token verification for the /promote handler.
 * Implementations receive the raw Authorization header (may be undefined) and
 * return a verified PromotePrincipal, or throw AppError(PERMISSION_DENIED).
 */
export interface OidcVerifier {
  verify(authorization: string | undefined, opts?: OidcVerifyOptions): Promise<PromotePrincipal>;
}

/**
 * Narrow structural seam over the underlying JWT verifier (e.g. JwtRsaVerifier
 * from aws-jwt-verify). Declaring only the verify() shape we need keeps the
 * seam narrow and lets tests inject a plain-object fake without pulling in
 * the full library or hitting a live JWKS endpoint.
 *
 * The real JwtRsaVerifier satisfies this interface structurally.
 */
export interface OidcJwtVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Production OIDC verifier for GitHub Actions tokens.
 *
 * The injected `verifier` (built at the composition root via
 * `JwtRsaVerifier.create`) validates iss, aud, exp, nbf, and signature
 * automatically.  We extract `repository`, `ref` and the optional `head_ref`, `event_name` and
 * `job_workflow_ref` from the returned claims
 * and map any error to an opaque PERMISSION_DENIED.
 */
export class GithubOidcAuthenticator implements OidcVerifier {
  private readonly verifier: OidcJwtVerifier;

  /**
   * @param verifier - A pre-built OidcJwtVerifier (JwtRsaVerifier at runtime,
   *   or a fake in tests).  Built once at boot so the JWKS cache is shared
   *   per-process.
   */
  constructor(verifier: OidcJwtVerifier) {
    this.verifier = verifier;
  }

  /**
   * Verifies the GitHub Actions OIDC JWT from the Authorization header.
   *
   * `_opts` (dev-only ref override) is intentionally ignored here.
   *
   * @param authorization - Raw value of the HTTP Authorization header.
   * @returns Verified PromotePrincipal { repository, ref, headRef, eventName, jobWorkflowRef }.
   * @throws AppError(PERMISSION_DENIED) on ANY verification failure (opaque).
   */
  async verify(
    authorization: string | undefined,
    _opts?: OidcVerifyOptions,
  ): Promise<PromotePrincipal> {
    try {
      // RFC 7235: scheme tokens are case-insensitive.
      if (!authorization || !/^bearer /i.test(authorization)) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Extract the JWT after the 7-char "Bearer " prefix.
      // The regex above guarantees the prefix is present and exactly 7 chars.
      const token = authorization.slice(7);

      // Delegate to the injected verifier: iss, aud, exp, nbf, and signature
      // are verified inside JwtRsaVerifier; any failure throws.
      const claims = await this.verifier.verify(token);

      // Extract required claims.  Both must be non-empty strings.
      const repository = typeof claims['repository'] === 'string' ? claims['repository'] : '';
      const ref = typeof claims['ref'] === 'string' ? claims['ref'] : '';

      if (!repository || !ref) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Optional: GitHub sets head_ref only for pull_request workflows.
      const headRef =
        typeof claims['head_ref'] === 'string' && claims['head_ref'] !== ''
          ? claims['head_ref']
          : null;

      // Optional: bind the event and workflow file that minted the token; the
      // /promote merged path requires push + promote.yml on the default branch.
      const eventName =
        typeof claims['event_name'] === 'string' && claims['event_name'] !== ''
          ? claims['event_name']
          : null;
      const jobWorkflowRef =
        typeof claims['job_workflow_ref'] === 'string' && claims['job_workflow_ref'] !== ''
          ? claims['job_workflow_ref']
          : null;

      return { repository, ref, headRef, eventName, jobWorkflowRef };
    } catch (err) {
      // Re-throw our own AppError as-is; map everything else opaquely.
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
  }
}
