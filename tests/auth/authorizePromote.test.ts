/**
 * M2 — RdsAuthorizer.authorizePromote unit tests.
 *
 * Uses InMemoryAuthRepository (no DB). Covers all denial paths and the happy
 * path for the machine-credential gate (Decision 3 — /promote OIDC path).
 *
 * Denial cases:
 *  - absent credential (no row seeded for the project/principal pair)
 *  - revoked/expired credential (active: false simulates both)
 *  - credential with a disallowed role (e.g. 'viewer' not in the allowed set)
 *  - credential for a different project (wrong projectId → treated as absent)
 * Happy path:
 *  - active service_agent credential → ActorIdentity with correct actorId + roles
 *  - active contributor credential → ActorIdentity
 *  - active project_admin credential → ActorIdentity
 * Opacity:
 *  - all denial paths produce the same byte-identical 'Access denied.' message
 */

import { describe, it, expect } from 'vitest';
import { RdsAuthorizer } from '../../src/auth/authorizer.js';
import { InMemoryAuthRepository } from './fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { PromotePrincipal } from '../../src/auth/oidcAuthenticator.js';
import type { TenantContext } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-mc-001';
const REPO_ID = 'repo-mc-001';
const OWNER_REPO = 'acme/billing';

const tenant: TenantContext = { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' };

function makePrincipal(repository: string = OWNER_REPO): PromotePrincipal {
  return { repository, ref: 'refs/heads/main' };
}

// ---------------------------------------------------------------------------
// Happy path — active credentials
// ---------------------------------------------------------------------------

describe('RdsAuthorizer.authorizePromote — happy path', () => {
  it('returns ActorIdentity for an active service_agent credential', async () => {
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'service_agent', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    const actor = await authorizer.authorizePromote(makePrincipal(), tenant);

    expect(actor.actorId).toBe(OWNER_REPO);
    expect(actor.roles).toContain('service_agent');
  });

  it('returns ActorIdentity for an active contributor credential', async () => {
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'contributor', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    const actor = await authorizer.authorizePromote(makePrincipal(), tenant);

    expect(actor.actorId).toBe(OWNER_REPO);
    expect(actor.roles).toContain('contributor');
  });

  it('returns ActorIdentity for an active project_admin credential', async () => {
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'project_admin', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    const actor = await authorizer.authorizePromote(makePrincipal(), tenant);

    expect(actor.actorId).toBe(OWNER_REPO);
    expect(actor.roles).toContain('project_admin');
  });

  it('actorId equals principal.repository (not an internal UUID)', async () => {
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'service_agent', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    const actor = await authorizer.authorizePromote(makePrincipal(), tenant);

    // actorId must be the OIDC repository slug, not an internal ID
    expect(actor.actorId).toBe(OWNER_REPO);
  });
});

// ---------------------------------------------------------------------------
// Denial paths
// ---------------------------------------------------------------------------

describe('RdsAuthorizer.authorizePromote — denial paths', () => {
  it('throws PERMISSION_DENIED for an absent credential (no row seeded)', async () => {
    const repo = new InMemoryAuthRepository(); // no machine credentials seeded
    const authorizer = new RdsAuthorizer(repo);

    await expect(
      authorizer.authorizePromote(makePrincipal(), tenant),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for a revoked credential (active: false)', async () => {
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'service_agent', active: false }],
    );
    const authorizer = new RdsAuthorizer(repo);

    await expect(
      authorizer.authorizePromote(makePrincipal(), tenant),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for an expired credential (active: false simulates expiry)', async () => {
    // The fake models revoked + expired identically via active:false (mirrors
    // the SQL: revoked_at IS NULL AND expires_at > now() — both checked by the
    // PgAuthRepository; InMemoryAuthRepository uses active:false for either).
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'service_agent', active: false }],
    );
    const authorizer = new RdsAuthorizer(repo);

    await expect(
      authorizer.authorizePromote(makePrincipal(), tenant),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for a credential with a disallowed role (viewer)', async () => {
    // 'viewer' is not in the allowed machine roles set ('service_agent','contributor','project_admin').
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'viewer', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    await expect(
      authorizer.authorizePromote(makePrincipal(), tenant),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED for a credential belonging to a different project', async () => {
    // Credential seeded under 'other-project', but the tenant is PROJECT_ID → absent.
    const repo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: 'other-project', principalName: OWNER_REPO, role: 'service_agent', active: true }],
    );
    const authorizer = new RdsAuthorizer(repo);

    await expect(
      authorizer.authorizePromote(makePrincipal(), tenant), // tenant.projectId = PROJECT_ID
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });
});

// ---------------------------------------------------------------------------
// Opacity: all denial messages are byte-identical
// ---------------------------------------------------------------------------

describe('RdsAuthorizer.authorizePromote — opacity', () => {
  it('all denial paths produce the same "Access denied." message', async () => {
    const absentRepo = new InMemoryAuthRepository();
    const revokedRepo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'service_agent', active: false }],
    );
    const wrongRoleRepo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: PROJECT_ID, principalName: OWNER_REPO, role: 'viewer', active: true }],
    );
    const wrongProjectRepo = new InMemoryAuthRepository(
      [],
      [],
      [],
      [{ projectId: 'different-project', principalName: OWNER_REPO, role: 'service_agent', active: true }],
    );

    const denials = [
      new RdsAuthorizer(absentRepo).authorizePromote(makePrincipal(), tenant),
      new RdsAuthorizer(revokedRepo).authorizePromote(makePrincipal(), tenant),
      new RdsAuthorizer(wrongRoleRepo).authorizePromote(makePrincipal(), tenant),
      new RdsAuthorizer(wrongProjectRepo).authorizePromote(makePrincipal(), tenant),
    ];

    for (const promise of denials) {
      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
      expect((err as AppError).opaqueMessage).toBe('Access denied.');
    }
  });
});
