/**
 * T162: CognitoAuthenticator — Gate-1 unit tests.
 *
 * Tests all verification outcomes by injecting a fake verifier so no live
 * Cognito endpoint or JWKS network call is needed. The fake verifier is a
 * plain object implementing the minimal `{ verify(token): Promise<payload> }`
 * shape accepted by CognitoAuthenticator's constructor.
 *
 * NOTE: src/auth/authenticator.ts imports aws-jwt-verify, which is declared
 * in package.json but NOT yet installed. If the module cannot resolve at run
 * time, these tests will fail with ERR_MODULE_NOT_FOUND — that is the
 * expected pending-install state, not a test bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitoAuthenticator } from '../../src/auth/authenticator.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { Principal } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fake verifier — replaces the real CognitoJwtVerifier for deterministic tests
// ---------------------------------------------------------------------------

interface FakeJwtPayload {
  sub: string;
  client_id: string;
  scope: string;
}

/** Minimal verifier shape accepted by CognitoAuthenticator. */
function makeFakeVerifier() {
  return {
    verify: vi.fn<[string], Promise<FakeJwtPayload>>(),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PAYLOAD: FakeJwtPayload = {
  sub: 'user-abc-123',
  client_id: 'client-xyz',
  scope: 'read:memory write:staging',
};

const VALID_HEADER = 'Bearer valid-token';
const MULTI_SCOPE_PRINCIPAL: Principal = {
  subject: 'user-abc-123',
  clientId: 'client-xyz',
  scopes: ['read:memory', 'write:staging'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CognitoAuthenticator — Gate 1', () => {
  let fakeVerifier: ReturnType<typeof makeFakeVerifier>;
  let authenticator: CognitoAuthenticator;

  beforeEach(() => {
    fakeVerifier = makeFakeVerifier();
    authenticator = new CognitoAuthenticator(fakeVerifier);
  });

  // --- Happy path ---

  it('returns a Principal when the verifier resolves', async () => {
    fakeVerifier.verify.mockResolvedValue(VALID_PAYLOAD);

    const principal = await authenticator.authenticate(VALID_HEADER);

    expect(principal).toEqual<Principal>(MULTI_SCOPE_PRINCIPAL);
  });

  it('strips the "Bearer " prefix before calling the verifier', async () => {
    fakeVerifier.verify.mockResolvedValue(VALID_PAYLOAD);

    await authenticator.authenticate(VALID_HEADER);

    expect(fakeVerifier.verify).toHaveBeenCalledWith('valid-token');
  });

  it('splits a single-scope payload into a one-element scopes array', async () => {
    fakeVerifier.verify.mockResolvedValue({ ...VALID_PAYLOAD, scope: 'read:memory' });

    const principal = await authenticator.authenticate(VALID_HEADER);

    expect(principal.scopes).toEqual(['read:memory']);
  });

  it('ignores opts.devUser: identity comes only from the verified token', async () => {
    fakeVerifier.verify.mockResolvedValue(VALID_PAYLOAD);

    const principal = await authenticator.authenticate(VALID_HEADER, { devUser: 'tl@demo.local' });

    expect(principal).toEqual<Principal>(MULTI_SCOPE_PRINCIPAL);
    await expect(
      authenticator.authenticate(undefined, { devUser: 'tl@demo.local' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Denial paths — all must throw AppError(PERMISSION_DENIED) ---

  it('throws PERMISSION_DENIED when Authorization header is undefined', async () => {
    await expect(authenticator.authenticate(undefined)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when Authorization header is empty string', async () => {
    await expect(authenticator.authenticate('')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when Authorization lacks "Bearer " prefix', async () => {
    await expect(authenticator.authenticate('invalid-token')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when verifier rejects (invalid signature)', async () => {
    fakeVerifier.verify.mockRejectedValue(new Error('JwtInvalidSignatureError'));

    await expect(authenticator.authenticate(VALID_HEADER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when verifier rejects (token expired)', async () => {
    fakeVerifier.verify.mockRejectedValue(new Error('JwtExpiredError'));

    await expect(authenticator.authenticate(VALID_HEADER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when verifier rejects (wrong client_id)', async () => {
    fakeVerifier.verify.mockRejectedValue(new Error('JwtInvalidClaimError: client_id'));

    await expect(authenticator.authenticate(VALID_HEADER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when verifier rejects (missing required scope)', async () => {
    fakeVerifier.verify.mockRejectedValue(new Error('JwtInvalidScopeError'));

    await expect(authenticator.authenticate(VALID_HEADER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Opacity: all denied tokens produce the same opaque message ---

  it('all denials produce the opaque "Access denied." message', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['undefined header', undefined],
      ['empty string', ''],
      ['no Bearer prefix', 'raw-token'],
    ];

    for (const [label, header] of cases) {
      const err = await authenticator.authenticate(header).catch((e: unknown) => e);
      expect(err, `case "${label}": expected AppError`).toBeInstanceOf(AppError);
      expect(
        (err as AppError).opaqueMessage,
        `case "${label}": wrong message`,
      ).toBe('Access denied.');
    }
  });

  it('verifier rejection produces the opaque "Access denied." message', async () => {
    fakeVerifier.verify.mockRejectedValue(new Error('any internal error'));

    const err = await authenticator.authenticate(VALID_HEADER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).opaqueMessage).toBe('Access denied.');
  });
});
