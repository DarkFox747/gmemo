/**
 * Gate 1: Cognito JWT authentication.
 *
 * CognitoAuthenticator verifies an access token against the Cognito JWKS and
 * returns a Principal on success. Any failure — bad signature, wrong iss,
 * expired token, client_id not in the allowlist, missing required scope, or
 * absent/malformed Authorization header — is mapped opaquely to
 * AppError(PERMISSION_DENIED). No detail about WHY the token was rejected is
 * forwarded to the caller.
 *
 * The verifier is injected at construction time (built once at boot in
 * src/index.ts via CognitoJwtVerifier.create). Per-call construction would
 * defeat the in-process JWKS cache that handles key rotation.
 *
 * `aud` is NOT validated — Cognito access tokens carry `client_id` + `scope`
 * and no `aud`; the clientId allowlist in the verifier is the
 * audience-equivalent check.
 */

import { AppError, ErrorCode } from '../errors/appError.js';
import type { Authenticator, Principal } from '../mcp/context.js';

/**
 * Minimal interface over CognitoJwtVerifier from aws-jwt-verify.
 * Declaring only the verify() shape we need keeps the seam narrow and lets
 * tests inject a simple fake without pulling in the full library.
 * The real CognitoJwtVerifier satisfies this interface structurally.
 */
export interface CognitoVerifier {
  verify(token: string): Promise<{
    sub: string;
    client_id: string;
    scope: string | undefined;
  }>;
}

export class CognitoAuthenticator implements Authenticator {
  private readonly verifier: CognitoVerifier;

  /**
   * @param verifier - A pre-built CognitoJwtVerifier (built once at boot).
   *   Boot should call verifier.hydrate() best-effort before constructing this
   *   instance so JWKS keys are pre-warmed; the verifier lazy-fetches on the
   *   first verify() call if hydration was skipped or failed.
   */
  constructor(verifier: CognitoVerifier) {
    this.verifier = verifier;
  }

  /**
   * Verifies the Cognito access JWT from the Authorization header.
   *
   * @param authorization - Raw value of the HTTP Authorization header.
   * @returns Verified Principal (sub, clientId, scopes).
   * @throws AppError(PERMISSION_DENIED) on ANY verification failure (opaque).
   */
  async authenticate(authorization: string | undefined): Promise<Principal> {
    try {
      // RFC 7235: scheme tokens are case-insensitive; accept any casing of "Bearer".
      if (!authorization || !/^bearer /i.test(authorization)) {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }

      // Extract token after the first space (handles any case of the scheme prefix).
      const token = authorization.slice(authorization.indexOf(' ') + 1);

      const payload = await this.verifier.verify(token);

      return {
        subject: payload.sub,
        clientId: payload.client_id,
        scopes: payload.scope ? payload.scope.split(' ').filter(Boolean) : [],
      };
    } catch (err) {
      // Re-throw our own AppError as-is; map everything else to PERMISSION_DENIED.
      if (err instanceof AppError) throw err;
      throw new AppError(ErrorCode.PERMISSION_DENIED, err);
    }
  }
}
