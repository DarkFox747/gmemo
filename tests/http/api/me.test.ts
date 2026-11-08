/**
 * GET /api/v1/me — identity endpoint.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PROJECT_A, USERS, bearer, makeApiTestApp } from './helpers.js';

describe('GET /api/v1/me', () => {
  it('returns the user and non-archived projects with role', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app).get('/api/v1/me').set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: USERS.adminA.userId, email: 'tl@demo.local', displayName: 'TL A' },
      projects: [{ id: PROJECT_A, slug: 'alpha', name: 'Alpha', role: 'project_admin' }],
    });
  });

  it.each([
    [USERS.contributorA, 'contributor'],
    [USERS.viewerA, 'viewer'],
  ])('shows the membership role (%#)', async (user, role) => {
    const { app } = makeApiTestApp();
    const res = await request(app).get('/api/v1/me').set('Authorization', bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([{ id: PROJECT_A, slug: 'alpha', name: 'Alpha', role }]);
  });

  it('platform_admin without memberships → empty project list', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(USERS.platformAdmin));
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it('writes one me.read audit row with project null and no email', async () => {
    const { app, authRepo } = makeApiTestApp();
    await request(app).get('/api/v1/me').set('Authorization', bearer(USERS.adminA));
    expect(authRepo.accessLogEntries).toHaveLength(1);
    const row = authRepo.accessLogEntries[0];
    expect(row).toMatchObject({
      actorIdentity: USERS.adminA.subject,
      actorKind: 'user',
      action: 'read',
      projectId: null,
      detail: { api: 'me.read', userId: USERS.adminA.userId },
    });
    expect(JSON.stringify(row)).not.toContain('tl@demo.local');
  });

  it('disabled user → opaque 404 and no audit row', async () => {
    const { app, authRepo } = makeApiTestApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(USERS.disabledAdminA));
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(authRepo.accessLogEntries).toHaveLength(0);
  });
});
