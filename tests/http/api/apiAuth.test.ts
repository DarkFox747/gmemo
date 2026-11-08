/**
 * apiAuth — Gate 1 on /api and the X-Dev-User transport guard (design D1, layer 2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { USERS, bearer, makeApiTestApp } from './helpers.js';
import { DevAuthenticator } from '../../../src/auth/devAuthenticator.js';
import { InMemoryAuthRepository } from '../../auth/fakes.js';
import { RdsAuthorizer } from '../../../src/auth/authorizer.js';
import { RdsAuditLogger } from '../../../src/auth/auditLogger.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('apiAuth (Gate 1)', () => {
  it('no token → 401 {"error":"Unauthorized"} with no-store', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.text).toBe('{"error":"Unauthorized"}');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('valid token → principal reaches the route', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app).get('/api/v1/me').set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('unknown /api path without a token → 401 (auth runs before the catch-all)', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app).get('/api/v1/unknown');
    expect(res.status).toBe(401);
  });

  it('unknown /api path with a token → JSON 404', async () => {
    const { app } = makeApiTestApp();
    const res = await request(app)
      .get('/api/v1/unknown')
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
  });
});

describe('X-Dev-User forwarding', () => {
  it('flag off → the header is never forwarded', async () => {
    const { app, authenticator } = makeApiTestApp({}, { devUserHeader: false });
    await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(USERS.adminA))
      .set('X-Dev-User', 'viewer@demo.local');
    expect(authenticator.calls).toHaveLength(1);
    expect(authenticator.calls[0].opts?.devUser).toBeUndefined();
  });

  it('flag on (non-production) → header forwarded as devUser', async () => {
    process.env.NODE_ENV = 'test';
    const { app, authenticator } = makeApiTestApp({}, { devUserHeader: true });
    await request(app)
      .get('/api/v1/me')
      .set('Authorization', bearer(USERS.adminA))
      .set('X-Dev-User', 'viewer@demo.local');
    expect(authenticator.calls[0].opts?.devUser).toBe('viewer@demo.local');
  });

  it('flag on but NODE_ENV=production → header dropped; missing token → 401', async () => {
    process.env.NODE_ENV = 'production';
    const { app, authenticator } = makeApiTestApp({}, { devUserHeader: true });
    const res = await request(app).get('/api/v1/me').set('X-Dev-User', 'tl@demo.local');
    expect(res.status).toBe(401);
    expect(authenticator.calls).toHaveLength(1);
    expect(authenticator.calls[0].opts?.devUser).toBeUndefined();
  });
});

describe('development login through DevAuthenticator', () => {
  function devApp() {
    process.env.NODE_ENV = 'test';
    const authRepo = new InMemoryAuthRepository(
      [],
      [
        {
          subject: 'dev-local-user',
          userId: 'u-default',
          globalRole: null,
          email: 'dev@localhost',
        },
        { subject: 'demo-tl', userId: 'u-tl', globalRole: null, email: 'tl@demo.local' },
        {
          subject: 'demo-viewer',
          userId: 'u-viewer',
          globalRole: null,
          email: 'viewer@demo.local',
        },
      ],
      [
        { projectId: 'p-1', userId: 'u-tl', role: 'project_admin' },
        { projectId: 'p-1', userId: 'u-viewer', role: 'viewer' },
        { projectId: 'p-1', userId: 'u-default', role: 'contributor' },
      ],
      [],
      [{ projectId: 'p-1', slug: 'demo', name: 'Demo' }],
    );
    return makeApiTestApp(
      {
        authenticator: new DevAuthenticator(authRepo),
        authorizer: new RdsAuthorizer(authRepo),
        auditLogger: new RdsAuditLogger(authRepo),
        authRepository: authRepo,
      },
      { devUserHeader: true },
    ).app;
  }

  it('tl@demo.local → project_admin; viewer@demo.local → viewer', async () => {
    const app = devApp();
    const tl = await request(app).get('/api/v1/me').set('X-Dev-User', 'TL@demo.local');
    expect(tl.status).toBe(200);
    expect(tl.body.projects).toEqual([
      { id: 'p-1', slug: 'demo', name: 'Demo', role: 'project_admin' },
    ]);
    const viewer = await request(app).get('/api/v1/me').set('X-Dev-User', 'viewer@demo.local');
    expect(viewer.body.projects[0].role).toBe('viewer');
  });

  it('absent header → default dev user', async () => {
    const res = await request(devApp()).get('/api/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('dev@localhost');
  });

  it('unknown email → 401', async () => {
    const res = await request(devApp()).get('/api/v1/me').set('X-Dev-User', 'nobody@demo.local');
    expect(res.status).toBe(401);
    expect(res.text).toBe('{"error":"Unauthorized"}');
  });
});
