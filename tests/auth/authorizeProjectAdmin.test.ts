/**
 * RdsAuthorizer.authorizeProjectAdmin + authorizeUser — Gate 2 for the REST API.
 *
 * authorizeProjectAdmin passes ONLY an enabled user holding project_admin on
 * the project. Every other case (other role, no membership, disabled, absent,
 * platform role without membership, DB error) gets the identical denial.
 */

import { describe, it, expect } from 'vitest';
import { RdsAuthorizer } from '../../src/auth/authorizer.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { InMemoryAuthRepository } from './fakes.js';
import type { AuthRepository } from '../../src/db/authRepository.js';
import type { Principal } from '../../src/mcp/context.js';

const P = 'proj-p';
const OTHER = 'proj-other';

const USERS = [
  {
    subject: 'admin',
    userId: 'u-admin',
    globalRole: null,
    email: 'admin@x.io',
    displayName: 'Admin',
  },
  { subject: 'contrib', userId: 'u-contrib', globalRole: null, email: 'contrib@x.io' },
  { subject: 'viewer', userId: 'u-viewer', globalRole: null, email: 'viewer@x.io' },
  { subject: 'agent', userId: 'u-agent', globalRole: null, email: 'agent@x.io' },
  { subject: 'nomember', userId: 'u-nomember', globalRole: null, email: 'nomember@x.io' },
  {
    subject: 'disabled-admin',
    userId: 'u-dis',
    globalRole: null,
    email: 'dis@x.io',
    disabled: true,
  },
  {
    subject: 'platform',
    userId: 'u-platform',
    globalRole: 'platform_admin',
    email: 'platform@x.io',
  },
  { subject: 'other-admin', userId: 'u-other', globalRole: null, email: 'other@x.io' },
  { subject: 'owner-admin', userId: 'u-owner', globalRole: 'platform_owner', email: 'owner@x.io' },
];

const MEMBERSHIPS = [
  { projectId: P, userId: 'u-admin', role: 'project_admin' },
  { projectId: P, userId: 'u-contrib', role: 'contributor' },
  { projectId: P, userId: 'u-viewer', role: 'viewer' },
  { projectId: P, userId: 'u-agent', role: 'service_agent' },
  { projectId: P, userId: 'u-dis', role: 'project_admin' },
  { projectId: OTHER, userId: 'u-other', role: 'project_admin' },
  { projectId: P, userId: 'u-owner', role: 'project_admin' },
];

const ARCHIVED = 'proj-archived';
const PROJECTS = [
  { projectId: P, slug: 'p', name: 'P' },
  { projectId: OTHER, slug: 'other', name: 'Other' },
  { projectId: ARCHIVED, slug: 'old', name: 'Old', archived: true },
];
const ALL_MEMBERSHIPS = [
  ...MEMBERSHIPS,
  { projectId: ARCHIVED, userId: 'u-admin', role: 'project_admin' },
];

const authorizer = new RdsAuthorizer(
  new InMemoryAuthRepository([], USERS, ALL_MEMBERSHIPS, [], PROJECTS),
);

function principalFor(subject: string): Principal {
  return { subject, clientId: 'client-1', scopes: [] };
}

async function denialMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    return (err as AppError).message;
  }
  throw new Error('expected a denial');
}

function failingRepo(): AuthRepository {
  const repo = new InMemoryAuthRepository([], USERS, ALL_MEMBERSHIPS, [], PROJECTS);
  repo.findMembershipRole = () => Promise.reject(new Error('db down'));
  return repo;
}

describe('RdsAuthorizer.authorizeProjectAdmin', () => {
  it('returns an AdminActor for an enabled project_admin', async () => {
    const actor = await authorizer.authorizeProjectAdmin(principalFor('admin'), P);
    expect(actor).toEqual({ actorId: 'admin', userId: 'u-admin', roles: ['project_admin'] });
  });

  it('puts the global role first, then the membership role', async () => {
    const actor = await authorizer.authorizeProjectAdmin(principalFor('owner-admin'), P);
    expect(actor.roles).toEqual(['platform_owner', 'project_admin']);
    expect(actor.userId).toBe('u-owner');
  });

  it('denies a project_admin on an archived project with the same opaque error', async () => {
    const archivedMsg = await denialMessage(
      authorizer.authorizeProjectAdmin(principalFor('admin'), ARCHIVED),
    );
    const viewerMsg = await denialMessage(
      authorizer.authorizeProjectAdmin(principalFor('viewer'), P),
    );
    expect(archivedMsg).toBe(viewerMsg);
  });

  it('denies every non-admin case with an identical error', async () => {
    const subjects = [
      'contrib',
      'viewer',
      'agent',
      'nomember',
      'disabled-admin',
      'absent',
      'platform',
      'other-admin',
    ];
    const messages = await Promise.all(
      subjects.map((s) => denialMessage(authorizer.authorizeProjectAdmin(principalFor(s), P))),
    );
    messages.push(
      await denialMessage(authorizer.authorizeProjectAdmin(principalFor('admin'), ARCHIVED)),
    );
    const failing = new RdsAuthorizer(failingRepo());
    messages.push(await denialMessage(failing.authorizeProjectAdmin(principalFor('admin'), P)));
    expect(new Set(messages).size).toBe(1);
  });
});

describe('RdsAuthorizer.authorizeUser', () => {
  it('returns the Gate-2 identity of an enabled user (no membership required)', async () => {
    await expect(authorizer.authorizeUser(principalFor('admin'))).resolves.toEqual({
      actorId: 'admin',
      userId: 'u-admin',
      email: 'admin@x.io',
      displayName: 'Admin',
      globalRole: null,
    });
    const platform = await authorizer.authorizeUser(principalFor('platform'));
    expect(platform.globalRole).toBe('platform_admin');
    expect(platform.displayName).toBeNull();
  });

  it('denies absent, disabled and DB-error cases identically', async () => {
    const repo = new InMemoryAuthRepository([], USERS, ALL_MEMBERSHIPS, [], PROJECTS);
    repo.findEnabledUserBySubject = () => Promise.reject(new Error('db down'));
    const messages = [
      await denialMessage(authorizer.authorizeUser(principalFor('absent'))),
      await denialMessage(authorizer.authorizeUser(principalFor('disabled-admin'))),
      await denialMessage(new RdsAuthorizer(repo).authorizeUser(principalFor('admin'))),
    ];
    expect(new Set(messages).size).toBe(1);
  });
});
