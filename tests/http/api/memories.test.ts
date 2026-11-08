/**
 * Memory lifecycle routes (C4, HU-12.2, HU-12.3, HU-11.4) over the real
 * LifecycleService + FakeLifecycleRepository, real RBAC and real audit logger.
 *
 *   GET  /api/v1/projects/:projectId/memories
 *   POST /api/v1/projects/:projectId/memories/:memoryId/confirm
 *   POST /api/v1/projects/:projectId/memories/:memoryId/retire
 *   POST /api/v1/projects/:projectId/memories/retire-by-pr
 */

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PROJECT_A, PROJECT_B, USERS, bearer, makeApiTestApp } from './helpers.js';
import { makeMemory } from '../../lifecycle/fakes.js';
import { logger } from '../../../src/observability/logger.js';

const BASE = `/api/v1/projects/${PROJECT_A}/memories`;
const NOT_FOUND_BODY = '{"error":"Not found"}';
const INVALID_BODY = '{"error":"Invalid request"}';
const DAY_MS = 86_400_000;
const admin = bearer(USERS.adminA);

describe('GET /memories', () => {
  it('lists pending memories of the project (default status) and audits memories.list', async () => {
    const kit = makeApiTestApp();
    const due = new Date(Date.now() - DAY_MS);
    const pending = makeMemory({
      projectId: PROJECT_A,
      status: 'pending_revalidation',
      revalidateAt: due,
    });
    kit.lifecycleRepo.memories.push(
      pending,
      makeMemory({ projectId: PROJECT_A, status: 'active' }),
      makeMemory({ projectId: PROJECT_B, status: 'pending_revalidation' }),
    );

    const res = await request(kit.app).get(BASE).set('Authorization', admin);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        expect.objectContaining({
          id: pending.id,
          status: 'pending_revalidation',
          version: 1,
          revalidateAt: due.toISOString(),
        }),
      ],
      truncated: false,
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'read',
      projectId: PROJECT_A,
      detail: { api: 'memories.list', status: 'pending_revalidation', resultCount: 1 },
    });
  });

  it('honours limit and reports truncation', async () => {
    const kit = makeApiTestApp();
    for (let i = 0; i < 3; i++) {
      kit.lifecycleRepo.memories.push(
        makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' }),
      );
    }
    const res = await request(kit.app).get(`${BASE}?limit=2`).set('Authorization', admin);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.truncated).toBe(true);
  });

  it.each(['status=active', 'status=bogus', 'limit=0', 'limit=201', 'unknown=1'])(
    'rejects ?%s with 400 and no audit',
    async (qs) => {
      const kit = makeApiTestApp();
      const res = await request(kit.app).get(`${BASE}?${qs}`).set('Authorization', admin);
      expect(res.status).toBe(400);
      expect(res.text).toBe(INVALID_BODY);
      expect(kit.authRepo.accessLogEntries).toHaveLength(0);
    },
  );
});

describe('POST /memories/:memoryId/confirm', () => {
  it('pending → 200 active with a fresh deadline; audited once as update', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(m);

    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/confirm`)
      .set('Authorization', admin)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.memoryId).toBe(m.id);
    expect(res.body.status).toBe('active');
    expect((Date.parse(res.body.revalidateAt) - Date.now()) / DAY_MS).toBeGreaterThan(59.9);
    expect(m.status).toBe('active');
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      memoryId: m.id,
      detail: { api: 'memory.confirm', memoryId: m.id },
    });
  });

  it('accepts an empty body (no JSON payload)', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/confirm`)
      .set('Authorization', admin)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
  });

  it('active (D2), repeat, foreign project row and unknown id → identical 404, no audit', async () => {
    const kit = makeApiTestApp();
    const active = makeMemory({ projectId: PROJECT_A });
    const foreign = makeMemory({ projectId: PROJECT_B, status: 'pending_revalidation' });
    const pending = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(active, foreign, pending);

    const ok = await request(kit.app)
      .post(`${BASE}/${pending.id}/confirm`)
      .set('Authorization', admin)
      .send({});
    expect(ok.status).toBe(200);
    kit.authRepo.accessLogEntries.length = 0;

    for (const id of [active.id, pending.id, foreign.id, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11']) {
      const res = await request(kit.app)
        .post(`${BASE}/${id}/confirm`)
        .set('Authorization', admin)
        .send({});
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
    }
    expect(foreign.status).toBe('pending_revalidation');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('a body with keys → 400', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/confirm`)
      .set('Authorization', admin)
      .send({ force: true });
    expect(res.status).toBe(400);
    expect(m.status).toBe('pending_revalidation');
  });

  it('a malformed memory id → 404 before validation', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/not-a-uuid/confirm`)
      .set('Authorization', admin)
      .send({ force: true });
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });

  it('form-encoded POST → 400 for the admin (JSON required)', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/confirm`)
      .set('Authorization', admin)
      .type('form')
      .send('a=1');
    expect(res.status).toBe(400);
    expect(m.status).toBe('pending_revalidation');
  });
});

describe('POST /memories/:memoryId/retire', () => {
  it('active → 200 deprecated with the new version; audit carries no reason', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A });
    kit.lifecycleRepo.memories.push(m);

    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/retire`)
      .set('Authorization', admin)
      .send({ reason: '  obsolete after migration  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ memoryId: m.id, status: 'deprecated', version: 2 });
    expect(m.retiredReason).toBe('obsolete after migration');
    expect(kit.lifecycleRepo.revisions).toEqual([
      { memoryId: m.id, revisionNo: 2, op: 'deprecate', authorIdentity: USERS.adminA.subject },
    ]);
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      detail: { api: 'memory.retire', memoryId: m.id },
    });
    expect(JSON.stringify(kit.authRepo.accessLogEntries)).not.toContain('obsolete');
  });

  it('pending → 200 as well', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, status: 'pending_revalidation' });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/retire`)
      .set('Authorization', admin)
      .send({ reason: 'no longer true' });
    expect(res.status).toBe(200);
    expect(m.status).toBe('deprecated');
  });

  it('deprecated, superseded or foreign → 404 with no revision', async () => {
    const kit = makeApiTestApp();
    const rows = [
      makeMemory({ projectId: PROJECT_A, status: 'deprecated' }),
      makeMemory({ projectId: PROJECT_A, status: 'superseded' }),
      makeMemory({ projectId: PROJECT_B }),
    ];
    kit.lifecycleRepo.memories.push(...rows);
    for (const m of rows) {
      const res = await request(kit.app)
        .post(`${BASE}/${m.id}/retire`)
        .set('Authorization', admin)
        .send({ reason: 'should not apply' });
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
    }
    expect(kit.lifecycleRepo.revisions).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it.each([
    ['2-char reason', { reason: 'ab' }],
    ['501-char reason', { reason: 'x'.repeat(501) }],
    ['missing reason', {}],
    ['extra key', { reason: 'fine reason', extra: 1 }],
    ['non-string reason', { reason: 42 }],
  ])('%s → 400, nothing stored', async (_name, body) => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/retire`)
      .set('Authorization', admin)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe(INVALID_BODY);
    expect(m.status).toBe('active');
  });

  it('a reason with an AWS key → 400; nothing stored or echoed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/${m.id}/retire`)
      .set('Authorization', admin)
      .send({ reason: 'key AKIAIOSFODNN7EXAMPLE leaked' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('AKIA');
    expect(m.status).toBe('active');
    expect(kit.lifecycleRepo.calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('a reason with an email is stored masked', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A });
    kit.lifecycleRepo.memories.push(m);
    await request(kit.app)
      .post(`${BASE}/${m.id}/retire`)
      .set('Authorization', admin)
      .send({ reason: 'ask jane.doe@example.com' });
    expect(m.retiredReason).toBe('ask [EMAIL]');
  });
});

describe('POST /memories/retire-by-pr', () => {
  it('retires active + pending of that PR in this project only → {retired: 3}; audited', async () => {
    const kit = makeApiTestApp();
    const targets = [
      makeMemory({ projectId: PROJECT_A, originPr: 42 }),
      makeMemory({ projectId: PROJECT_A, originPr: 42 }),
      makeMemory({ projectId: PROJECT_A, originPr: 42, status: 'pending_revalidation' }),
    ];
    const untouched = [
      makeMemory({ projectId: PROJECT_A, originPr: 42, status: 'deprecated' }),
      makeMemory({ projectId: PROJECT_A, originPr: 43 }),
      makeMemory({ projectId: PROJECT_B, originPr: 42 }),
    ];
    kit.lifecycleRepo.memories.push(...targets, ...untouched);

    const res = await request(kit.app)
      .post(`${BASE}/retire-by-pr`)
      .set('Authorization', admin)
      .send({ originPr: 42, reason: 'PR 42 was reverted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retired: 3 });
    for (const m of targets) expect(m.status).toBe('deprecated');
    expect(untouched.map((m) => m.status)).toEqual(['deprecated', 'active', 'active']);
    expect(kit.lifecycleRepo.revisions).toHaveLength(3);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      detail: { api: 'memory.retire_by_pr', originPr: 42, resultCount: 3 },
    });

    const again = await request(kit.app)
      .post(`${BASE}/retire-by-pr`)
      .set('Authorization', admin)
      .send({ originPr: 42, reason: 'PR 42 was reverted' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ retired: 0 });
    expect(kit.lifecycleRepo.revisions).toHaveLength(3);
  });

  it.each([0, -1, '42', 1.5, null])('originPr %j → 400', async (originPr) => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/retire-by-pr`)
      .set('Authorization', admin)
      .send({ originPr, reason: 'valid reason' });
    expect(res.status).toBe(400);
    expect(kit.lifecycleRepo.calls).toHaveLength(0);
  });

  it('a secret reason → 400 with no repository call', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/retire-by-pr`)
      .set('Authorization', admin)
      .send({ originPr: 42, reason: 'token AKIAIOSFODNN7EXAMPLE' });
    expect(res.status).toBe(400);
    expect(kit.lifecycleRepo.calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('contributor → 404 and nothing changes', async () => {
    const kit = makeApiTestApp();
    const m = makeMemory({ projectId: PROJECT_A, originPr: 42 });
    kit.lifecycleRepo.memories.push(m);
    const res = await request(kit.app)
      .post(`${BASE}/retire-by-pr`)
      .set('Authorization', bearer(USERS.contributorA))
      .send({ originPr: 42, reason: 'PR 42 was reverted' });
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
    expect(m.status).toBe('active');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });
});
