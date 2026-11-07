/**
 * T164: RdsAuthorizer — Gate-2 + RBAC unit tests.
 *
 * Uses InMemoryAuthRepository so no real database is needed. Covers:
 *  - user absent from app_user → PERMISSION_DENIED
 *  - user present but disabled_at IS NOT NULL → PERMISSION_DENIED
 *  - enabled user with no project_membership row → PERMISSION_DENIED
 *  - happy path: enabled user with membership → correct ActorIdentity
 *  - platform global role holder WITHOUT a membership row → still PERMISSION_DENIED (D4)
 *  - machine/service-agent path: any non-Cognito bearer → Gate 1 denies before
 *    reaching Gate 2; this test confirms Gate 2 alone (when given a principal
 *    whose sub maps to a user with no membership) also denies — fail-closed.
 */

import { describe, it, expect } from 'vitest';
import { RdsAuthorizer } from '../../src/auth/authorizer.js';
import { InMemoryAuthRepository } from './fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { Principal, TenantContext, ActorIdentity, ToolName } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-uuid-001';
const REPO_ID = 'repo-uuid-001';

const USERS = [
  { subject: 'active-user', userId: 'u-001', globalRole: null },
  { subject: 'disabled-user', userId: 'u-002', globalRole: null, disabled: true },
  { subject: 'platform-owner', userId: 'u-003', globalRole: 'platform_owner' },
  { subject: 'no-member-user', userId: 'u-004', globalRole: null },
];

const MEMBERSHIPS = [
  { projectId: PROJECT_ID, userId: 'u-001', role: 'viewer' },
  // u-002 is disabled, no membership needed
  // u-003 has global role but NO membership row (D4 test)
  // u-004 is enabled but has no membership
];

const repo = new InMemoryAuthRepository([], USERS, MEMBERSHIPS);
const authorizer = new RdsAuthorizer(repo);

const tenant: TenantContext = { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' };

function principalFor(subject: string): Principal {
  return { subject, clientId: 'client-1', scopes: ['read:memory'] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RdsAuthorizer — Gate 2 + RBAC', () => {
  // --- Denial paths ---

  it('throws PERMISSION_DENIED when subject maps to no app_user row', async () => {
    await expect(
      authorizer.authorize(principalFor('non-existent-sub'), tenant, 'recall'),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when user is disabled (indistinguishable from absent)', async () => {
    await expect(
      authorizer.authorize(principalFor('disabled-user'), tenant, 'recall'),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when enabled user has no project_membership row', async () => {
    await expect(
      authorizer.authorize(principalFor('no-member-user'), tenant, 'recall'),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for a platform_owner with no membership row (D4)', async () => {
    // Design decision D4: global roles still require a membership row for reads.
    // A platform_owner without a project_membership row must be denied just like
    // any other user — roles are NOT sourced from token claims.
    await expect(
      authorizer.authorize(principalFor('platform-owner'), tenant, 'recall'),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for a service-agent bearer arriving at Gate 2 (fail-closed)', async () => {
    // In production, a non-Cognito bearer is rejected at Gate 1 (authenticate).
    // This test confirms Gate 2 is also fail-closed: any principal whose sub
    // maps to a user with no membership is denied, regardless of how it arrived.
    await expect(
      authorizer.authorize(principalFor('no-member-user'), tenant, 'get_memory'),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Happy path ---

  it('returns ActorIdentity for an enabled user with a membership row', async () => {
    const actor: ActorIdentity = await authorizer.authorize(
      principalFor('active-user'),
      tenant,
      'recall',
    );

    expect(actor.actorId).toBe('active-user');
    expect(actor.roles).toContain('viewer');
  });

  it('actorId on the returned ActorIdentity equals the JWT sub (raw subject)', async () => {
    const actor = await authorizer.authorize(principalFor('active-user'), tenant, 'recall');

    // Design: actorId = principal.subject = JWT `sub`, not an internal UUID.
    expect(actor.actorId).toBe('active-user');
  });

  it('roles array includes the project membership role', async () => {
    const actor = await authorizer.authorize(principalFor('active-user'), tenant, 'recall');

    expect(Array.isArray(actor.roles)).toBe(true);
    expect(actor.roles).toContain('viewer');
  });

  // --- Opacity: all denial messages are byte-identical ---

  it('all denial paths produce the same "Access denied." message', async () => {
    const denials = [
      authorizer.authorize(principalFor('non-existent-sub'), tenant, 'recall'),
      authorizer.authorize(principalFor('disabled-user'), tenant, 'recall'),
      authorizer.authorize(principalFor('no-member-user'), tenant, 'recall'),
      authorizer.authorize(principalFor('platform-owner'), tenant, 'recall'),
    ];

    for (const promise of denials) {
      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).opaqueMessage).toBe('Access denied.');
    }
  });
});

// ---------------------------------------------------------------------------
// Write-role matrix
// ---------------------------------------------------------------------------

describe('RdsAuthorizer — write-role matrix', () => {
  // New repo + authorizer seeded with all four membership roles.
  // Isolated from the module-level fixtures above to keep this block self-contained.
  const WR_PROJECT = 'proj-wr-001';
  const WR_REPO = 'repo-wr-001';

  const wrRepo = new InMemoryAuthRepository(
    [],
    [
      { subject: 'wr-viewer',        userId: 'wu-001', globalRole: null },
      { subject: 'wr-contributor',   userId: 'wu-002', globalRole: null },
      { subject: 'wr-service-agent', userId: 'wu-003', globalRole: null },
      { subject: 'wr-project-admin', userId: 'wu-004', globalRole: null },
    ],
    [
      { projectId: WR_PROJECT, userId: 'wu-001', role: 'viewer' },
      { projectId: WR_PROJECT, userId: 'wu-002', role: 'contributor' },
      { projectId: WR_PROJECT, userId: 'wu-003', role: 'service_agent' },
      { projectId: WR_PROJECT, userId: 'wu-004', role: 'project_admin' },
    ],
  );
  const wrAuthorizer = new RdsAuthorizer(wrRepo);
  const wrTenant: TenantContext = { projectId: WR_PROJECT, repoId: WR_REPO, branch: 'main' };

  function wrPrincipalFor(subject: string): Principal {
    return { subject, clientId: 'client-1', scopes: ['read:memory'] };
  }

  const WRITE_TOOLS: ToolName[] = ['remember', 'list_staged', 'discard_staged'];
  const READ_TOOLS: ToolName[] = ['recall', 'get_memory', 'get_context'];

  const WRITER_ROLES: Array<{ subject: string; role: string }> = [
    { subject: 'wr-contributor',   role: 'contributor' },
    { subject: 'wr-service-agent', role: 'service_agent' },
    { subject: 'wr-project-admin', role: 'project_admin' },
  ];

  const ALL_ROLES: Array<{ subject: string; role: string }> = [
    { subject: 'wr-viewer',        role: 'viewer' },
    ...WRITER_ROLES,
  ];

  // --- viewer is DENIED on every write tool ---

  for (const tool of WRITE_TOOLS) {
    it(`throws PERMISSION_DENIED for viewer on write tool "${tool}"`, async () => {
      await expect(
        wrAuthorizer.authorize(wrPrincipalFor('wr-viewer'), wrTenant, tool),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
      );
    });
  }

  // --- contributor / service_agent / project_admin are ALLOWED on every write tool ---

  for (const { subject, role } of WRITER_ROLES) {
    for (const tool of WRITE_TOOLS) {
      it(`returns ActorIdentity for ${role} on write tool "${tool}"`, async () => {
        const actor: ActorIdentity = await wrAuthorizer.authorize(
          wrPrincipalFor(subject),
          wrTenant,
          tool,
        );
        expect(actor.actorId).toBe(subject);
        expect(actor.roles).toContain(role);
      });
    }
  }

  // --- read-tool behavior UNCHANGED: all roles (including viewer) may read ---

  for (const { subject, role } of ALL_ROLES) {
    for (const tool of READ_TOOLS) {
      it(`allows ${role} on read tool "${tool}" (unchanged)`, async () => {
        const actor: ActorIdentity = await wrAuthorizer.authorize(
          wrPrincipalFor(subject),
          wrTenant,
          tool,
        );
        expect(actor.actorId).toBe(subject);
      });
    }
  }
});
