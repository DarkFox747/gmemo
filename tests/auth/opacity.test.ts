/**
 * T166: Opacity guarantee — every denial path yields an identical "Access denied." response.
 *
 * The contract requires that ALL of the following produce byte-identical opaque
 * error results to the caller:
 *  - Gate 1 failure (invalid/absent JWT)         — [blocked by aws-jwt-verify install]
 *  - Tenant not found (unknown X-Git-Remote)
 *  - User absent from app_user
 *  - User present but disabled
 *  - No project_membership row (including platform_owner without membership)
 *  - Machine/service-agent bearer (fails at Gate 1 → no machine_credential lookup)
 *
 * No access_log row must be written for any of these denials.
 *
 * The Gate-1 section is marked with a note that it requires aws-jwt-verify
 * (not installed yet). All other sections use InMemoryAuthRepository and are
 * fast/deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RdsTenantResolver } from '../../src/auth/tenantResolver.js';
import { RdsAuthorizer } from '../../src/auth/authorizer.js';
import { InMemoryAuthRepository } from './fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { toToolErrorResult } from '../../src/errors/toToolResult.js';
import type { Principal, TenantContext } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

const OPAQUE_DENIAL = 'Access denied.';

function assertOpaqueAppError(err: unknown): void {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
  expect((err as AppError).opaqueMessage).toBe(OPAQUE_DENIAL);
}

function assertToolResultOpaque(err: unknown): void {
  const result = toToolErrorResult(err);
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].text).toBe(OPAQUE_DENIAL);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_REMOTE = 'https://github.com/acme/api.git';
const PROJECT_ID = 'proj-uuid-001';
const REPO_ID = 'repo-uuid-001';

const tenant: TenantContext = { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' };

function principalFor(subject: string): Principal {
  return { subject, clientId: 'client-1', scopes: ['read:memory'] };
}

// ---------------------------------------------------------------------------
// Section 1: AppError(PERMISSION_DENIED) → toToolErrorResult opacity
// ---------------------------------------------------------------------------

describe('opacity — AppError(PERMISSION_DENIED) message', () => {
  it('maps to the opaque "Access denied." tool result text', () => {
    const result = toToolErrorResult(new AppError(ErrorCode.PERMISSION_DENIED));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(OPAQUE_DENIAL);
  });

  it('message is byte-identical regardless of AppError cause', () => {
    const withCause = new AppError(ErrorCode.PERMISSION_DENIED, new Error('internal detail'));
    const withoutCause = new AppError(ErrorCode.PERMISSION_DENIED);

    const r1 = toToolErrorResult(withCause);
    const r2 = toToolErrorResult(withoutCause);
    expect(r1.content[0].text).toBe(r2.content[0].text);
  });

  it('does not expose the cause in the tool result', () => {
    const cause = new Error('secret internal reason: project=proj-secret');
    const err = new AppError(ErrorCode.PERMISSION_DENIED, cause);
    const result = toToolErrorResult(err);

    expect(result.content[0].text).not.toContain('secret');
    expect(result.content[0].text).not.toContain('proj-secret');
  });
});

// ---------------------------------------------------------------------------
// Section 2: Tenant resolution denials
// ---------------------------------------------------------------------------

describe('opacity — tenant resolution denials (no aws-jwt-verify dependency)', () => {
  let repo: InMemoryAuthRepository;
  let resolver: RdsTenantResolver;

  beforeEach(() => {
    repo = new InMemoryAuthRepository([
      { remoteUrl: REPO_REMOTE, repoId: REPO_ID, projectId: PROJECT_ID, defaultBranch: 'main' },
    ]);
    resolver = new RdsTenantResolver(repo);
  });

  it('unknown remote URL → AppError(PERMISSION_DENIED)', async () => {
    const err = await resolver
      .resolve({ authorization: 'Bearer t', gitRemote: 'https://github.com/nobody/repo.git', branch: undefined })
      .catch((e: unknown) => e);

    assertOpaqueAppError(err);
  });

  it('unknown remote URL → opaque tool result "Access denied."', async () => {
    const err = await resolver
      .resolve({ authorization: 'Bearer t', gitRemote: 'https://github.com/nobody/repo.git', branch: undefined })
      .catch((e: unknown) => e);

    assertToolResultOpaque(err);
  });

  it('missing X-Git-Remote → same opaque message as unknown remote', async () => {
    const unknownErr = await resolver
      .resolve({ authorization: 'Bearer t', gitRemote: 'https://unknown.git', branch: undefined })
      .catch((e: unknown) => e);

    const missingErr = await resolver
      .resolve({ authorization: 'Bearer t', gitRemote: undefined, branch: undefined })
      .catch((e: unknown) => e);

    expect((unknownErr as AppError).opaqueMessage).toBe((missingErr as AppError).opaqueMessage);
    expect((missingErr as AppError).opaqueMessage).toBe(OPAQUE_DENIAL);
  });

  it('no access_log row is written on tenant denial', async () => {
    await resolver
      .resolve({ authorization: 'Bearer t', gitRemote: undefined, branch: undefined })
      .catch(() => { /* expected */ });

    expect(repo.accessLogEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Authorizer denials
// ---------------------------------------------------------------------------

describe('opacity — authorizer denials (no aws-jwt-verify dependency)', () => {
  let repo: InMemoryAuthRepository;
  let authorizer: RdsAuthorizer;

  beforeEach(() => {
    repo = new InMemoryAuthRepository(
      [],
      [
        { subject: 'disabled-user', userId: 'u-disabled', globalRole: null, disabled: true },
        { subject: 'platform-owner', userId: 'u-owner', globalRole: 'platform_owner' },
        // 'absent-user' is intentionally not seeded
      ],
      [], // no memberships
    );
    authorizer = new RdsAuthorizer(repo);
  });

  const denialCases: Array<[string, string]> = [
    ['user absent from app_user', 'absent-user'],
    ['user present but disabled', 'disabled-user'],
    ['platform_owner without membership (D4)', 'platform-owner'],
  ];

  for (const [label, subject] of denialCases) {
    it(`${label} → AppError(PERMISSION_DENIED)`, async () => {
      const err = await authorizer
        .authorize(principalFor(subject), tenant, 'recall')
        .catch((e: unknown) => e);

      assertOpaqueAppError(err);
    });

    it(`${label} → opaque tool result "Access denied."`, async () => {
      const err = await authorizer
        .authorize(principalFor(subject), tenant, 'recall')
        .catch((e: unknown) => e);

      assertToolResultOpaque(err);
    });
  }

  it('all denial messages are byte-identical (no enumeration)', async () => {
    const messages: string[] = [];

    for (const [, subject] of denialCases) {
      const err = await authorizer
        .authorize(principalFor(subject), tenant, 'recall')
        .catch((e: unknown) => e);
      messages.push((err as AppError).opaqueMessage);
    }

    // Every message must be identical — callers cannot distinguish cases
    const unique = new Set(messages);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe(OPAQUE_DENIAL);
  });

  it('no access_log row is written on any authorizer denial', async () => {
    for (const [, subject] of denialCases) {
      await authorizer
        .authorize(principalFor(subject), tenant, 'recall')
        .catch(() => { /* expected */ });
    }

    expect(repo.accessLogEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Gate-1 denial via CognitoAuthenticator
// NOTE: These tests require src/auth/authenticator.ts AND aws-jwt-verify to be
// installed. They are kept here for completeness; see authenticator.test.ts
// for the full Gate-1 suite with a fake verifier.
// ---------------------------------------------------------------------------

describe('opacity — Gate-1 denial message shape (verifiable without live Cognito)', () => {
  it('AppError(PERMISSION_DENIED) from Gate 1 produces the correct tool result shape', () => {
    // We simulate what the authenticator would throw without importing it.
    const gateOneDenial = new AppError(ErrorCode.PERMISSION_DENIED);
    const result = toToolErrorResult(gateOneDenial);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(OPAQUE_DENIAL);
  });
});
