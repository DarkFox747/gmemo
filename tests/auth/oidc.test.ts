/**
 * T020 + T006 (promote-oidc): OIDC authenticator unit tests.
 *
 * Covers both implementations of the OidcVerifier seam:
 *
 *  1. DevOidcAuthenticator — DEV-only stub that always returns the fixed
 *     DEV_PROMOTE_PRINCIPAL regardless of the Authorization header (or its
 *     absence). Verified shape: repository='crombie-llc/gmemo-demo',
 *     ref='refs/heads/main' (or opts.devRef when given), headRef=null,
 *     eventName='push', jobWorkflowRef=promote.yml on refs/heads/main.
 *
 *  2. GithubOidcAuthenticator — real implementation with an injected fake
 *     OidcJwtVerifier. Tests cover the full fail-closed matrix without any
 *     live network call or real JWKS endpoint.
 *
 * Design ref: openspec/changes/promote-oidc/design.md §"Test Strategy".
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DevOidcAuthenticator,
  DEV_PROMOTE_PRINCIPAL,
} from '../../src/auth/devOidcAuthenticator.js';
import { GithubOidcAuthenticator, type OidcJwtVerifier } from '../../src/auth/oidcAuthenticator.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds an OidcJwtVerifier fake that resolves with the given claims object. */
function makeFakeVerifier(claims: Record<string, unknown>): OidcJwtVerifier {
  return { verify: vi.fn<[string], Promise<Record<string, unknown>>>().mockResolvedValue(claims) };
}

/** Builds an OidcJwtVerifier fake that rejects with the given error. */
function makeRejectingVerifier(err: unknown = new Error('jwt-verify-failed')): OidcJwtVerifier {
  return { verify: vi.fn<[string], Promise<Record<string, unknown>>>().mockRejectedValue(err) };
}

const VALID_CLAIMS = {
  repository: 'org/repo',
  ref: 'refs/heads/main',
  iss: 'github',
  aud: 'gmemo',
};
const VALID_HEADER = 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.token';

// ---------------------------------------------------------------------------
// Section 1: DevOidcAuthenticator
// ---------------------------------------------------------------------------

describe('DevOidcAuthenticator', () => {
  const auth = new DevOidcAuthenticator();

  it('returns DEV_PROMOTE_PRINCIPAL when authorization header is undefined', async () => {
    const principal = await auth.verify(undefined);
    expect(principal).toEqual(DEV_PROMOTE_PRINCIPAL);
  });

  it('returns DEV_PROMOTE_PRINCIPAL for a well-formed Bearer token (arg ignored)', async () => {
    const principal = await auth.verify('Bearer eyJhbGciOiJSUzI1NiJ9.fake.token');
    expect(principal).toEqual(DEV_PROMOTE_PRINCIPAL);
  });

  it('returns DEV_PROMOTE_PRINCIPAL for a garbage authorization header (arg ignored)', async () => {
    const principal = await auth.verify('not-a-real-token!!garbage');
    expect(principal).toEqual(DEV_PROMOTE_PRINCIPAL);
  });

  it('DEV_PROMOTE_PRINCIPAL.repository equals the seed machine_credential principal_name', () => {
    expect(DEV_PROMOTE_PRINCIPAL.repository).toBe('crombie-llc/gmemo-demo');
  });

  it('DEV_PROMOTE_PRINCIPAL.ref is the expected main branch ref', () => {
    expect(DEV_PROMOTE_PRINCIPAL.ref).toBe('refs/heads/main');
  });

  it('never throws — resolves for undefined, valid-looking, and garbage headers', async () => {
    await expect(auth.verify(undefined)).resolves.toEqual(DEV_PROMOTE_PRINCIPAL);
    await expect(auth.verify('Bearer anything')).resolves.toEqual(DEV_PROMOTE_PRINCIPAL);
    await expect(auth.verify('garbage!!!')).resolves.toEqual(DEV_PROMOTE_PRINCIPAL);
  });

  it('returned object has exactly the principal fields', async () => {
    const principal = await auth.verify(undefined);
    expect(Object.keys(principal).sort()).toEqual([
      'eventName',
      'headRef',
      'jobWorkflowRef',
      'ref',
      'repository',
    ]);
    expect(principal.headRef).toBeNull();
    expect(principal.eventName).toBe('push');
    expect(principal.jobWorkflowRef).toBe(
      'crombie-llc/gmemo-demo/.github/workflows/promote.yml@refs/heads/main',
    );
  });

  it('honours opts.devRef as the ref (dev-only), keeping the fixed repository and headRef null', async () => {
    const principal = await auth.verify(undefined, { devRef: 'refs/heads/feature/x' });
    expect(principal).toEqual({
      repository: 'crombie-llc/gmemo-demo',
      ref: 'refs/heads/feature/x',
      headRef: null,
      eventName: 'push',
      jobWorkflowRef: 'crombie-llc/gmemo-demo/.github/workflows/promote.yml@refs/heads/main',
    });
  });

  it('does not mutate DEV_PROMOTE_PRINCIPAL when devRef is given', async () => {
    await auth.verify(undefined, { devRef: 'refs/heads/feature/y' });
    expect(DEV_PROMOTE_PRINCIPAL.ref).toBe('refs/heads/main');
  });
});

// ---------------------------------------------------------------------------
// Section 2: GithubOidcAuthenticator — real implementation with injected fake
// ---------------------------------------------------------------------------

describe('GithubOidcAuthenticator — injected fake verifier', () => {
  // --- Happy path ---

  it('valid token without optional claims → PromotePrincipal with null optionals', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS));
    const principal = await auth.verify(VALID_HEADER);
    expect(principal).toEqual({
      repository: 'org/repo',
      ref: 'refs/heads/main',
      headRef: null,
      eventName: null,
      jobWorkflowRef: null,
    });
  });

  it('returned principal has exactly the principal fields', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS));
    const principal = await auth.verify(VALID_HEADER);
    expect(Object.keys(principal).sort()).toEqual([
      'eventName',
      'headRef',
      'jobWorkflowRef',
      'ref',
      'repository',
    ]);
  });

  // --- event_name / job_workflow_ref claims (workflow binding for /promote) ---

  it('event_name and job_workflow_ref claims present → extracted', async () => {
    const jobWorkflowRef = 'org/repo/.github/workflows/promote.yml@refs/heads/main';
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ ...VALID_CLAIMS, event_name: 'push', job_workflow_ref: jobWorkflowRef }),
    );
    const principal = await auth.verify(VALID_HEADER);
    expect(principal.eventName).toBe('push');
    expect(principal.jobWorkflowRef).toBe(jobWorkflowRef);
  });

  it('event_name / job_workflow_ref empty or not a string → null', async () => {
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ ...VALID_CLAIMS, event_name: '', job_workflow_ref: 42 }),
    );
    const principal = await auth.verify(VALID_HEADER);
    expect(principal.eventName).toBeNull();
    expect(principal.jobWorkflowRef).toBeNull();
  });

  // --- head_ref claim (pull_request workflows) ---

  it('head_ref claim present → extracted as headRef', async () => {
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ ...VALID_CLAIMS, ref: 'refs/pull/7/merge', head_ref: 'feature/x' }),
    );
    const principal = await auth.verify(VALID_HEADER);
    expect(principal).toEqual({
      repository: 'org/repo',
      ref: 'refs/pull/7/merge',
      headRef: 'feature/x',
      eventName: null,
      jobWorkflowRef: null,
    });
  });

  it("head_ref claim empty string ('' on push workflows) → headRef null", async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier({ ...VALID_CLAIMS, head_ref: '' }));
    const principal = await auth.verify(VALID_HEADER);
    expect(principal.headRef).toBeNull();
  });

  it('head_ref claim not a string → headRef null', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier({ ...VALID_CLAIMS, head_ref: 42 }));
    const principal = await auth.verify(VALID_HEADER);
    expect(principal.headRef).toBeNull();
  });

  it('ignores opts.devRef (only the dev stub honours it)', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS));
    const principal = await auth.verify(VALID_HEADER, { devRef: 'refs/heads/feature/evil' });
    expect(principal.ref).toBe('refs/heads/main');
  });

  it('passes the raw JWT (after stripping Bearer prefix) to the underlying verifier', async () => {
    const fake = makeFakeVerifier(VALID_CLAIMS);
    const auth = new GithubOidcAuthenticator(fake);
    await auth.verify('Bearer my-jwt-token-123');
    expect(fake.verify).toHaveBeenCalledWith('my-jwt-token-123');
  });

  // --- Bearer-prefix validation (before verifier is called) ---

  it('missing authorization header → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS));
    await expect(auth.verify(undefined)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('authorization without Bearer prefix → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS));
    await expect(auth.verify('Token some-other-scheme')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Verifier failures (wrong aud / iss / expired / bad sig) ---

  it('wrong audience (verifier rejects) → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeRejectingVerifier(new Error('aud mismatch')));
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('wrong issuer (verifier rejects) → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeRejectingVerifier(new Error('iss mismatch')));
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('expired token (verifier rejects) → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeRejectingVerifier(new Error('token expired')));
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('bad signature (verifier rejects) → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeRejectingVerifier(new Error('invalid signature')));
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // nbf — not-yet-valid token: verifier rejects because nbf > now
  it('nbf: not-yet-valid token (verifier rejects nbf) → PERMISSION_DENIED (fail-closed)', async () => {
    const auth = new GithubOidcAuthenticator(
      makeRejectingVerifier(new Error('token not yet valid (nbf)')),
    );
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Missing required claims ---

  it('missing repository claim → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ ref: 'refs/heads/main' }), // no repository
    );
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('missing ref claim → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ repository: 'org/repo' }), // no ref
    );
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('empty repository claim → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(
      makeFakeVerifier({ repository: '', ref: 'refs/heads/main' }),
    );
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('empty ref claim → PERMISSION_DENIED', async () => {
    const auth = new GithubOidcAuthenticator(makeFakeVerifier({ repository: 'org/repo', ref: '' }));
    await expect(auth.verify(VALID_HEADER)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Opaque denial invariant ---

  it('all denial paths produce byte-identical opaque messages (no enumeration)', async () => {
    const cases: Array<[string, GithubOidcAuthenticator]> = [
      ['missing header', new GithubOidcAuthenticator(makeFakeVerifier(VALID_CLAIMS))],
      ['wrong aud', new GithubOidcAuthenticator(makeRejectingVerifier())],
      ['missing repo', new GithubOidcAuthenticator(makeFakeVerifier({ ref: 'refs/heads/main' }))],
      ['missing ref', new GithubOidcAuthenticator(makeFakeVerifier({ repository: 'org/repo' }))],
    ];

    const inputs: Array<[string, string | undefined]> = [
      ['missing header', undefined],
      ['wrong aud', VALID_HEADER],
      ['missing repo', VALID_HEADER],
      ['missing ref', VALID_HEADER],
    ];

    const messages: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const [, auth] = cases[i];
      const [, input] = inputs[i];
      const err = await auth.verify(input).catch((e: unknown) => e);
      messages.push((err as AppError).opaqueMessage);
    }

    const unique = new Set(messages);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe('Access denied.');
  });
});
