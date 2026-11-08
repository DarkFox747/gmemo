/**
 * RdsAuthorizer.authorizeProjectMember — Gate 2 for the quarantine routes (C3).
 * Any membership passes and returns its projectRole; every other case gets the
 * identical opaque denial (platform roles never bypass).
 */

import { describe, it, expect } from 'vitest';
import { RdsAuthorizer } from '../../src/auth/authorizer.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { InMemoryAuthRepository } from './fakes.js';
import type { Principal } from '../../src/mcp/context.js';

const P = 'proj-p';
const ARCHIVED = 'proj-archived';

const USERS = [
  { subject: 'admin', userId: 'u-admin', globalRole: null },
  { subject: 'contrib', userId: 'u-contrib', globalRole: null },
  { subject: 'viewer', userId: 'u-viewer', globalRole: null },
  { subject: 'agent', userId: 'u-agent', globalRole: null },
  { subject: 'nomember', userId: 'u-nomember', globalRole: null },
  { subject: 'disabled', userId: 'u-dis', globalRole: null, disabled: true },
  { subject: 'platform', userId: 'u-platform', globalRole: 'platform_admin' },
  { subject: 'owner', userId: 'u-owner', globalRole: 'platform_owner' },
  { subject: 'weird', userId: 'u-weird', globalRole: null },
];

const MEMBERSHIPS = [
  { projectId: P, userId: 'u-admin', role: 'project_admin' },
  { projectId: P, userId: 'u-contrib', role: 'contributor' },
  { projectId: P, userId: 'u-viewer', role: 'viewer' },
  { projectId: P, userId: 'u-agent', role: 'service_agent' },
  { projectId: P, userId: 'u-dis', role: 'project_admin' },
  { projectId: P, userId: 'u-owner', role: 'contributor' },
  { projectId: P, userId: 'u-weird', role: 'superuser' },
  { projectId: ARCHIVED, userId: 'u-admin', role: 'project_admin' },
];

const PROJECTS = [
  { projectId: P, slug: 'p', name: 'P' },
  { projectId: ARCHIVED, slug: 'old', name: 'Old', archived: true },
];

const repo = new InMemoryAuthRepository([], USERS, MEMBERSHIPS, [], PROJECTS);
const authorizer = new RdsAuthorizer(repo);

const principal = (subject: string): Principal => ({ subject, clientId: 'c', scopes: [] });

async function denial(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    return (err as AppError).message;
  }
  throw new Error('expected a denial');
}

describe('RdsAuthorizer.authorizeProjectMember', () => {
  it.each([
    ['admin', 'project_admin'],
    ['contrib', 'contributor'],
    ['viewer', 'viewer'],
    ['agent', 'service_agent'],
  ])('%s → projectRole %s', async (subject, role) => {
    const m = await authorizer.authorizeProjectMember(principal(subject), P);
    expect(m).toEqual({
      actorId: subject,
      userId: `u-${subject}`,
      roles: [role],
      projectRole: role,
    });
  });

  it('puts the global role first', async () => {
    const m = await authorizer.authorizeProjectMember(principal('owner'), P);
    expect(m.roles).toEqual(['platform_owner', 'contributor']);
    expect(m.projectRole).toBe('contributor');
  });

  it('denies every non-member case with an identical error', async () => {
    const msgs = await Promise.all(
      ['nomember', 'disabled', 'absent', 'platform', 'weird'].map((s) =>
        denial(authorizer.authorizeProjectMember(principal(s), P)),
      ),
    );
    msgs.push(await denial(authorizer.authorizeProjectMember(principal('admin'), ARCHIVED)));
    const failingRepo = new InMemoryAuthRepository([], USERS, MEMBERSHIPS, [], PROJECTS);
    failingRepo.findMembershipRole = () => Promise.reject(new Error('db down'));
    msgs.push(
      await denial(new RdsAuthorizer(failingRepo).authorizeProjectMember(principal('admin'), P)),
    );
    expect(new Set(msgs).size).toBe(1);
  });
});
