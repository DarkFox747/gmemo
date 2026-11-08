/**
 * GET /api/v1/projects/:projectId/{dashboard,activity,staging} — governance insights (C12).
 *
 * project_admin only; every other caller gets the byte-identical opaque 404 and
 * no audit row. Strict query schemas (400 without echo, after authorization).
 * Successful reads are audited with counters / the status filter only.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ActivityListDto, StagingOverviewDto } from '../../../src/http/api/types.js';
import { PROJECT_A, PROJECT_B, RANDOM_PROJECT, USERS, bearer, makeApiTestApp } from './helpers.js';

const base = (p: string = PROJECT_A): string => `/api/v1/projects/${p}`;
const PATHS = ['dashboard', 'activity', 'staging'] as const;

const ACTIVITY: ActivityListDto = {
  items: [
    {
      id: '120',
      at: '2026-11-08T10:00:00.000Z',
      action: 'promotion.run',
      actor: { kind: 'ci', name: null },
      target: null,
      facts: { branch: 'feature/login', prNumber: 12, applied: 3, queued: 1, quarantined: 1 },
    },
    {
      id: '119',
      at: '2026-11-08T09:00:00.000Z',
      action: 'review.approve',
      actor: { kind: 'user', name: 'TL A' },
      target: { kind: 'memory', type: 'decision', title: 'Use RRF' },
      facts: {},
    },
  ],
  nextCursor: '119',
};

const STAGING: StagingOverviewDto = {
  truncated: false,
  sessions: [
    {
      id: '01JSESSION',
      repo: { id: 'r-1', label: 'acme/portal' },
      branch: 'feature/login',
      status: 'open',
      prNumber: null,
      openedBy: 'Dev',
      createdAt: '2026-11-08T08:00:00.000Z',
      lastActivityAt: '2026-11-08T09:00:00.000Z',
      expiresAt: '2026-11-15T09:00:00.000Z',
      closedAt: null,
      itemCount: 1,
      items: [
        {
          id: 'i-1',
          op: 'add',
          type: 'pattern',
          title: 'Ask [EMAIL] about retries',
          judgeState: 'pending',
          criterion: null,
          mandatoryReview: false,
          state: 'staged',
          createdAt: '2026-11-08T09:00:00.000Z',
        },
      ],
      itemsTruncated: false,
    },
  ],
};

function kit(): ReturnType<typeof makeApiTestApp> {
  const k = makeApiTestApp();
  k.insightsRepo.activity = ACTIVITY;
  k.insightsRepo.staging = STAGING;
  return k;
}

describe('governance insight endpoints', () => {
  it.each(PATHS)('project_admin → 200 + no-store on /%s', async (path) => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/${path}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('dashboard returns the repository DTO and audits dashboard.read without detail', async () => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/dashboard`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.body).toEqual(k.insightsRepo.dashboard);
    expect(k.insightsRepo.calls).toEqual([{ method: 'getDashboard', projectId: PROJECT_A }]);
    expect(k.authRepo.accessLogEntries).toHaveLength(1);
    const row = k.authRepo.accessLogEntries[0]!;
    expect(row).toMatchObject({ action: 'read', projectId: PROJECT_A });
    expect(row.detail).toEqual({ api: 'dashboard.read', userId: USERS.adminA.userId });
  });

  it('activity defaults (limit 50, no cursor/category) and audits the result count only', async () => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/activity`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.body).toEqual(ACTIVITY);
    expect(k.insightsRepo.calls[0]).toEqual({
      method: 'listActivity',
      projectId: PROJECT_A,
      q: { category: null, cursor: null, limit: 50 },
    });
    const row = k.authRepo.accessLogEntries[0]!;
    expect(row).toMatchObject({ action: 'read', projectId: PROJECT_A });
    expect(row.detail).toEqual({
      api: 'activity.list',
      resultCount: 2,
      userId: USERS.adminA.userId,
    });
    expect(JSON.stringify(row)).not.toContain('Use RRF');
    expect(row.queryHash).toBeUndefined();
  });

  it('activity passes category, cursor and limit through', async () => {
    const k = kit();
    await request(k.app)
      .get(`${base()}/activity?category=review&cursor=9223372036854775807&limit=10`)
      .set('Authorization', bearer(USERS.adminA));
    expect(k.insightsRepo.calls[0]!.q).toEqual({
      category: 'review',
      cursor: '9223372036854775807',
      limit: 10,
    });
  });

  it('staging defaults to open/20 and audits status + count', async () => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/staging`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.body).toEqual(STAGING);
    expect(k.insightsRepo.calls[0]).toEqual({
      method: 'listStaging',
      projectId: PROJECT_A,
      q: { status: 'open', limit: 20 },
    });
    const row = k.authRepo.accessLogEntries[0]!;
    expect(row.detail).toEqual({
      api: 'staging.list',
      status: 'open',
      resultCount: 1,
      userId: USERS.adminA.userId,
    });
    expect(JSON.stringify(row)).not.toContain('retries');
  });

  it('staging accepts status=closed', async () => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/staging?status=closed&limit=50`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(k.insightsRepo.calls[0]!.q).toEqual({ status: 'closed', limit: 50 });
  });

  const DENIED: Array<[string, { subject: string }, string]> = [
    ['contributor', USERS.contributorA, PROJECT_A],
    ['viewer', USERS.viewerA, PROJECT_A],
    ['service agent', USERS.serviceA, PROJECT_A],
    ['non-member admin', USERS.adminB, PROJECT_A],
    ['disabled admin', USERS.disabledAdminA, PROJECT_A],
    ['malformed id', USERS.adminA, 'not-a-uuid'],
    ['random id', USERS.adminA, RANDOM_PROJECT],
    ['other project', USERS.adminA, PROJECT_B],
  ];

  for (const path of PATHS) {
    it.each(DENIED)(`%s → opaque 404 on /${path} and no audit row`, async (_l, user, p) => {
      const k = kit();
      const res = await request(k.app)
        .get(`${base(p)}/${path}`)
        .set('Authorization', bearer(user));
      expect(res.status).toBe(404);
      expect(res.text).toBe('{"error":"Not found"}');
      expect(k.insightsRepo.calls).toEqual([]);
      expect(k.authRepo.accessLogEntries).toHaveLength(0);
    });
  }

  it.each([
    ['dashboard?days=90'],
    ['dashboard?x=1'],
    ['activity?x=1'],
    ['activity?category=review&category=memory'],
    ['activity?category=other'],
    ['activity?limit=0'],
    ['activity?limit=101'],
    ['activity?limit=abc'],
    ['activity?limit=1e1'],
    ['activity?limit=0x10'],
    ['activity?limit=5&limit=6'],
    ['activity?limit='],
    ['activity?cursor=-1'],
    ['activity?cursor=abc'],
    ['activity?cursor=0'],
    ['activity?cursor=9223372036854775808'],
    ['activity?cursor=1&cursor=2'],
    ['staging?status=all'],
    ['staging?limit=0'],
    ['staging?limit=51'],
    ['staging?limit=1e1'],
    ['staging?limit=5&limit=6'],
    ['staging?status=open&status=closed'],
    ['staging?category=review'],
  ])('admin %s → 400 without echo and nothing audited', async (path) => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/${path}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
    expect(k.insightsRepo.calls).toEqual([]);
    expect(k.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('a bad query from a non-admin is a 404, not a 400 (no oracle)', async () => {
    const k = kit();
    const res = await request(k.app)
      .get(`${base()}/activity?cursor=abc`)
      .set('Authorization', bearer(USERS.viewerA));
    expect(res.status).toBe(404);
  });

  it('unauthenticated → 401', async () => {
    const k = kit();
    const res = await request(k.app).get(`${base()}/dashboard`);
    expect(res.status).toBe(401);
  });
});
