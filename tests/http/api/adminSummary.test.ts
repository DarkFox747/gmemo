/**
 * GET /api/v1/projects/:projectId/admin-summary — read-only administration view (C7).
 *
 * project_admin only; every other caller gets the byte-identical opaque 404 and
 * no audit row. No query string is accepted (400 after authorization). The
 * response never carries a token or token hash.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AdminSummaryDto } from '../../../src/http/api/types.js';
import { PROJECT_A, PROJECT_B, RANDOM_PROJECT, USERS, bearer, makeApiTestApp } from './helpers.js';

const BASE = `/api/v1/projects/${PROJECT_A}/admin-summary`;
const FAKE_HASH = 'sha256-fake-token-hash-value';

function summary(): AdminSummaryDto {
  return {
    project: { id: PROJECT_A, slug: 'alpha', name: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z' },
    repos: [
      {
        id: 'r-1',
        remoteUrl: 'https://github.com/acme/portal',
        slug: 'acme/portal',
        provider: 'github',
        defaultBranch: 'main',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    members: [
      {
        userId: USERS.adminA.userId,
        email: USERS.adminA.email,
        displayName: 'TL A',
        role: 'project_admin',
        grantedAt: '2026-01-03T00:00:00.000Z',
        disabled: false,
      },
      {
        userId: USERS.viewerA.userId,
        email: USERS.viewerA.email,
        displayName: 'Viewer',
        role: 'viewer',
        grantedAt: '2026-01-03T00:00:00.000Z',
        disabled: false,
      },
    ],
    credentials: [
      {
        id: 'c-1',
        principalName: 'ci-portal',
        role: 'service_agent',
        createdAt: '2026-01-04T00:00:00.000Z',
        expiresAt: '2027-01-04T00:00:00.000Z',
        revokedAt: null,
        status: 'active',
      },
    ],
  };
}

function kitWithSummary(): ReturnType<typeof makeApiTestApp> {
  const kit = makeApiTestApp();
  kit.adminSummaryRepo.summaries.set(PROJECT_A, summary());
  return kit;
}

describe('GET /api/v1/projects/:projectId/admin-summary', () => {
  it('project_admin → 200 with the exact DTO and no-store', async () => {
    const kit = kitWithSummary();
    const res = await request(kit.app).get(BASE).set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(summary());
    expect(Object.keys(res.body).sort()).toEqual(['credentials', 'members', 'project', 'repos']);
    expect(Object.keys(res.body.credentials[0]).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'principalName',
      'revokedAt',
      'role',
      'status',
    ]);
  });

  it('the serialized body never contains a token key or the hash value', async () => {
    const kit = kitWithSummary();
    const res = await request(kit.app).get(BASE).set('Authorization', bearer(USERS.adminA));
    expect(res.text).not.toMatch(/token/i);
    expect(res.text).not.toContain(FAKE_HASH);
  });

  it('records admin_summary.read (read) with the member count only, after success', async () => {
    const kit = kitWithSummary();
    await request(kit.app).get(BASE).set('Authorization', bearer(USERS.adminA));
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    const row = kit.authRepo.accessLogEntries[0]!;
    expect(row).toMatchObject({
      action: 'read',
      projectId: PROJECT_A,
      detail: { api: 'admin_summary.read', resultCount: 2 },
    });
    expect(JSON.stringify(row)).not.toContain('@demo.local');
  });

  it.each([
    ['contributor', USERS.contributorA, BASE],
    ['viewer', USERS.viewerA, BASE],
    ['service agent', USERS.serviceA, BASE],
    ['non-member admin', USERS.adminB, BASE],
    ['disabled admin', USERS.disabledAdminA, BASE],
    ['malformed id', USERS.adminA, '/api/v1/projects/not-a-uuid/admin-summary'],
    ['random id', USERS.adminA, `/api/v1/projects/${RANDOM_PROJECT}/admin-summary`],
    ['other project', USERS.adminA, `/api/v1/projects/${PROJECT_B}/admin-summary`],
  ])('%s → opaque 404 and no audit row', async (_label, user, url) => {
    const kit = kitWithSummary();
    const res = await request(kit.app).get(url).set('Authorization', bearer(user));
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('repository null (e.g. archived) → 404 and no audit row', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).get(BASE).set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(kit.adminSummaryRepo.calls).toEqual([PROJECT_A]);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('unknown query key → 400 for an admin, 404 for a non-admin (no oracle)', async () => {
    const kit = kitWithSummary();
    const admin = await request(kit.app)
      .get(`${BASE}?limit=5`)
      .set('Authorization', bearer(USERS.adminA));
    expect(admin.status).toBe(400);
    expect(admin.text).toBe('{"error":"Invalid request"}');
    const viewer = await request(kit.app)
      .get(`${BASE}?limit=5`)
      .set('Authorization', bearer(USERS.viewerA));
    expect(viewer.status).toBe(404);
    expect(kit.adminSummaryRepo.calls).toEqual([]);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('unauthenticated → 401', async () => {
    const kit = kitWithSummary();
    const res = await request(kit.app).get(BASE);
    expect(res.status).toBe(401);
  });
});
