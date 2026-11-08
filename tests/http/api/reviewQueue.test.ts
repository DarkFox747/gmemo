/**
 * Review-queue routes as the project admin: validation (400), 404/409 mapping
 * and audit after success only.
 */

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ITEM_ID, PROJECT_A, USERS, bearer, makeApiTestApp } from './helpers.js';
import { logger } from '../../../src/observability/logger.js';
import { makeItem, makeRef } from '../../review/fakes.js';

const BASE = `/api/v1/projects/${PROJECT_A}/review-queue`;
const AUTH = bearer(USERS.adminA);

describe('GET …/review-queue (list)', () => {
  it('returns items + counters + truncated and audits review_queue.list', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.rows = [makeItem({ id: ITEM_ID })];
    const res = await request(kit.app)
      .get(`${BASE}?filter=uncertain&type=decision&limit=5`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: ITEM_ID, judgeState: 'uncertain', originPr: 7 });
    expect(res.body.counters).toEqual({
      pending: 2,
      uncertain: 1,
      mandatory: 1,
      resolvedLast7Days: 5,
    });
    expect(res.body.truncated).toBe(false);

    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'read',
      projectId: PROJECT_A,
      detail: { api: 'review_queue.list', filter: 'uncertain', type: 'decision', resultCount: 1 },
    });
  });

  it('defaults: filter=all, no type', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).get(BASE).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(kit.authRepo.accessLogEntries[0].detail).toMatchObject({
      filter: 'all',
      resultCount: 0,
    });
  });

  it.each([
    '?filter=bogus',
    '?type=nope',
    '?limit=0',
    '?limit=201',
    '?limit=abc',
    '?unknown=1',
    '?filter=all&filter=uncertain',
  ])('invalid query %s → 400 without echo and no audit', async (qs) => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).get(`${BASE}${qs}`).set('Authorization', AUTH);
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });
});

describe('GET …/review-queue/:itemId (detail)', () => {
  it('returns the detail with threshold, related ref and audits review_queue.read', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID, related_memory_id: 'mem-1' });
    kit.queueRepo.refs = [makeRef()];
    const res = await request(kit.app).get(`${BASE}/${ITEM_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ITEM_ID,
      body: 'B',
      threshold: 0.8,
      related: { id: 'mem-1', status: 'active', version: 3 },
      target: null,
      targetStale: false,
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0].detail).toMatchObject({
      api: 'review_queue.read',
      itemId: ITEM_ID,
    });
  });

  it('not queued (resolved / foreign) → 404, no audit', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).get(`${BASE}/${ITEM_ID}`).set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('malformed item id → 404', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem();
    const res = await request(kit.app).get(`${BASE}/not-a-uuid`).set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
  });
});

describe('POST …/approve', () => {
  it('approves (no body → defaults) and audits review_queue.approve as update', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID });
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/approve`)
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      itemId: ITEM_ID,
      decision: 'approved',
      memoryId: 'mem-9',
      deduped: false,
      rebasedFromRevision: null,
      relatedSuperseded: false,
    });
    expect(kit.promotionRepo.approveInputs[0]).toMatchObject({
      projectId: PROJECT_A,
      itemId: ITEM_ID,
      reviewerUserId: USERS.adminA.userId,
      targetRevision: null,
      markRelatedSuperseded: false,
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      projectId: PROJECT_A,
      memoryId: 'mem-9',
      detail: { api: 'review_queue.approve', itemId: ITEM_ID, decision: 'approved' },
    });
  });

  it('passes markRelatedSuperseded + targetRevision through', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID });
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/approve`)
      .set('Authorization', AUTH)
      .send({ markRelatedSuperseded: true, targetRevision: 2 });
    expect(res.status).toBe(200);
    expect(kit.promotionRepo.approveInputs[0]).toMatchObject({
      markRelatedSuperseded: true,
      targetRevision: 2,
    });
  });

  it.each([
    { markRelatedSuperseded: 'yes' },
    { targetRevision: 0 },
    { targetRevision: 1.5 },
    { extra: 1 },
  ])('invalid body %j → 400, no repo call, no audit', async (body) => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID });
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/approve`)
      .set('Authorization', AUTH)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
    expect(kit.promotionRepo.approveInputs).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it.each(['target_changed', 'target_inactive', 'duplicate_content'] as const)(
    'conflict %s → 409 {"error":"Conflict","code"} and no audit',
    async (code) => {
      const kit = makeApiTestApp();
      kit.queueRepo.item = makeItem({ id: ITEM_ID });
      kit.promotionRepo.approveResult = { status: 'conflict', code };
      const res = await request(kit.app)
        .post(`${BASE}/${ITEM_ID}/approve`)
        .set('Authorization', AUTH)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Conflict', code });
      expect(kit.authRepo.accessLogEntries).toHaveLength(0);
    },
  );

  it('already resolved (repo not_found) → 404 and no audit', async () => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID });
    kit.promotionRepo.approveResult = { status: 'not_found' };
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/approve`)
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(404);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('item not queued → 404 without calling the repo', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/approve`)
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(404);
    expect(kit.promotionRepo.approveInputs).toHaveLength(0);
  });
});

describe('POST …/reject', () => {
  it('rejects and audits review_queue.reject without the reason', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .send({ reason: 'too vague' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ itemId: ITEM_ID, decision: 'rejected' });
    expect(kit.promotionRepo.rejectInputs[0]).toMatchObject({
      reason: 'too vague',
      reviewerUserId: USERS.adminA.userId,
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    const row = kit.authRepo.accessLogEntries[0];
    expect(row).toMatchObject({
      action: 'update',
      detail: { api: 'review_queue.reject', itemId: ITEM_ID, decision: 'rejected' },
    });
    expect(JSON.stringify(row)).not.toContain('too vague');
  });

  it.each([
    {},
    { reason: 'ab' },
    { reason: '  ab  ' },
    { reason: 'x'.repeat(501) },
    { reason: 'ok reason', x: 1 },
  ])('invalid body %j → 400 without echo', async (body) => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
    expect(kit.promotionRepo.rejectInputs).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('reason with a secret → 400, nothing stored, not echoed', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .send({ reason: 'leaks AKIAIOSFODNN7EXAMPLE here' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('AKIA');
    expect(kit.promotionRepo.rejectInputs).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('already resolved → 404 and no audit', async () => {
    const kit = makeApiTestApp();
    kit.promotionRepo.rejectResult = 'not_found';
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .send({ reason: 'too vague' });
    expect(res.status).toBe(404);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('audit failure → 500 (fail closed)', async () => {
    const kit = makeApiTestApp({
      auditLogger: {
        recordRead: () => Promise.resolve(),
        recordWrite: () => Promise.resolve(),
        recordPromote: () => Promise.resolve(),
        recordAbandon: () => Promise.resolve(),
        recordApi: () => Promise.reject(new Error('db down')),
      },
    });
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .send({ reason: 'too vague' });
    expect(res.status).toBe(500);
  });
});

describe('Content-Type requirement on state-changing POSTs', () => {
  it.each(['approve', 'reject'])('%s without application/json -> 400, nothing changes', async (action) => {
    const kit = makeApiTestApp();
    kit.queueRepo.item = makeItem({ id: ITEM_ID });
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/${action}`)
      .set('Authorization', AUTH)
      .type('form')
      .send('reason=too+vague');
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
    expect(kit.promotionRepo.approveInputs).toHaveLength(0);
    expect(kit.promotionRepo.rejectInputs).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('text/plain body -> 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .set('Content-Type', 'text/plain')
      .send('{"reason":"too vague"}');
    expect(res.status).toBe(400);
  });

  it('application/json with a charset parameter is accepted', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/${ITEM_ID}/reject`)
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json; charset=utf-8')
      .send('{"reason":"too vague"}');
    expect(res.status).toBe(200);
  });
});

describe('audit failure after a committed decision is logged', () => {
  it('logs the item id (no reason) before failing closed', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const kit = makeApiTestApp({
        auditLogger: {
          recordRead: () => Promise.resolve(),
          recordWrite: () => Promise.resolve(),
          recordPromote: () => Promise.resolve(),
          recordAbandon: () => Promise.resolve(),
          recordApi: () => Promise.reject(new Error('db down')),
        },
      });
      const res = await request(kit.app)
        .post(`${BASE}/${ITEM_ID}/reject`)
        .set('Authorization', AUTH)
        .send({ reason: 'secret reason text' });
      expect(res.status).toBe(500);
      expect(spy.mock.calls.some((c) => JSON.stringify(c).includes(ITEM_ID))).toBe(true);
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret reason text');
    } finally {
      spy.mockRestore();
    }
  });
});
