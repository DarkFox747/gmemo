/**
 * Direct memory management routes (C5, HU-13) over the real DirectMemoryService
 * (fakes behind it), real RBAC and real audit logger: validation, outcome
 * mapping (200/400/404/409), audit after success only, content never audited.
 *
 *   POST /api/v1/projects/:projectId/memories/preview
 *   GET  /api/v1/projects/:projectId/memories/:memoryId
 *   POST /api/v1/projects/:projectId/memories
 *   PUT  /api/v1/projects/:projectId/memories/:memoryId
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import request from 'supertest';
import { PROJECT_A, PROJECT_B, USERS, bearer, makeApiTestApp } from './helpers.js';
import { makeAdminMemory, REPO_FOREIGN } from '../../memory/directFakes.js';
import { rejected } from '../../promote/fakes.js';
import { DETAIL } from '../../quarantine/fakes.js';
import { logger } from '../../../src/observability/logger.js';

const BASE = `/api/v1/projects/${PROJECT_A}/memories`;
const NOT_FOUND_BODY = '{"error":"Not found"}';
const INVALID_BODY = '{"error":"Invalid request"}';
const admin = bearer(USERS.adminA);

const UNIT = {
  type: 'gotcha',
  title: 'Pool exhaustion under load',
  summary: 'pg pool size 10 starves the worker under burst traffic.',
  body: 'Raise PGPOOL_MAX to 30 in src/db/pool.ts; symptom: timeouts after 30s.',
  fields: { symptom: 'timeouts' },
};

afterEach(() => vi.restoreAllMocks());

describe('POST /memories/preview', () => {
  it('200 with verdict and threshold; no domain write; audited once as read', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({ op: 'add', ...UNIT });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      outcome: 'apply',
      withoutApproval: 'apply',
      judge: { verdict: 'accepted', threshold: 0.8 },
      preview: { title: UNIT.title },
    });
    expect(kit.direct.staging.calls).toHaveLength(0);
    expect(kit.direct.promote.calls).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'read',
      detail: { api: 'memory.preview', type: 'gotcha', previewOutcome: 'apply' },
    });
    expect(JSON.stringify(kit.authRepo.accessLogEntries)).not.toContain('Pool exhaustion');
  });

  it('duplicate → quarantine outcome with the related memory', async () => {
    const kit = makeApiTestApp();
    const existing = makeAdminMemory({ projectId: PROJECT_A });
    kit.direct.adminRepo.memories.push(existing);
    kit.direct.promotion.context = [
      { id: existing.id, type: 'gotcha', title: existing.title, summary: existing.summary },
    ];
    const judgeSpy = vi
      .spyOn(kit.direct.judge, 'evaluate')
      .mockResolvedValue(rejected('duplication', existing.id));
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({ op: 'add', ...UNIT });
    expect(judgeSpy).toHaveBeenCalledOnce();
    expect(res.body).toMatchObject({
      outcome: 'quarantine',
      quarantineReasonCode: 'duplicate_content',
      judge: {
        criterion: 'duplication',
        related: { id: existing.id, status: 'active', version: 1 },
      },
    });
  });

  it('a credential is never echoed back', async () => {
    const kit = makeApiTestApp();
    const key = 'AKIAABCDEFGHIJKLMNOP';
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({ op: 'add', ...UNIT, body: `Deploy with ${key} today.` });
    expect(res.status).toBe(200);
    expect(res.body.pipeline).toMatchObject({ blocked: true, reasonCode: 'secret_detected' });
    expect(res.text).not.toContain(key);
  });

  it('amend preview: stale → 409 target_changed; missing → 404; no audit', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A, current_revision: 4 });
    kit.direct.adminRepo.memories.push(t);
    const stale = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({ op: 'amend', ...UNIT, targetMemoryId: t.id, expectedRevision: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'Conflict', code: 'target_changed' });
    const missing = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({
        op: 'amend',
        ...UNIT,
        targetMemoryId: '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11',
        expectedRevision: 1,
      });
    expect(missing.status).toBe(404);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('SEC-M2 judge down → 200 outcome unavailable; nothing written', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const kit = makeApiTestApp();
    vi.spyOn(kit.direct.judge, 'evaluate').mockRejectedValue(new Error('down'));
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send({ op: 'add', ...UNIT });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unavailable');
    expect(kit.direct.staging.calls).toHaveLength(0);
  });

  it('CR-L4 a non-JSON content type → 400, nothing evaluated, no audit', async () => {
    const kit = makeApiTestApp();
    const judgeSpy = vi.spyOn(kit.direct.judge, 'evaluate');
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .type('form')
      .send('op=add');
    expect(res.status).toBe(400);
    expect(res.text).toBe(INVALID_BODY);
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it.each([
    ['amend without targetMemoryId', { op: 'amend', ...UNIT, expectedRevision: 1 }],
    ['unknown op', { op: 'supersede', ...UNIT }],
    ['confirm is not a preview key', { op: 'add', ...UNIT, confirm: true }],
    ['unknown field key for the type', { op: 'add', ...UNIT, fields: { drivers: 'x' } }],
  ])('%s → 400', async (_l, body) => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`${BASE}/preview`)
      .set('Authorization', admin)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe(INVALID_BODY);
  });
});

describe('GET /memories/:memoryId', () => {
  it('200 detail with revisions; audited memory.read once', async () => {
    const kit = makeApiTestApp();
    const m = makeAdminMemory({
      projectId: PROJECT_A,
      status: 'deprecated',
      retired_reason: 'obsolete',
      current_revision: 2,
    });
    kit.direct.adminRepo.memories.push(m);
    kit.direct.adminRepo.addRevision(m.id, { revision_no: 1 });
    kit.direct.adminRepo.addRevision(m.id, { revision_no: 2, op: 'deprecate' });
    const res = await request(kit.app).get(`${BASE}/${m.id}`).set('Authorization', admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: m.id,
      status: 'deprecated',
      version: 2,
      retiredReason: 'obsolete',
      revisionsTruncated: false,
    });
    expect(res.body.revisions.map((r: { revisionNo: number }) => r.revisionNo)).toEqual([2, 1]);
    expect(kit.authRepo.accessLogEntries).toEqual([
      expect.objectContaining({
        action: 'read',
        memoryId: m.id,
        detail: expect.objectContaining({ api: 'memory.read' }),
      }),
    ]);
  });

  it('foreign, unknown and malformed ids → identical 404, no audit', async () => {
    const kit = makeApiTestApp();
    const foreign = makeAdminMemory({ projectId: PROJECT_B });
    kit.direct.adminRepo.memories.push(foreign);
    for (const id of [foreign.id, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11', 'not-a-uuid']) {
      const res = await request(kit.app).get(`${BASE}/${id}`).set('Authorization', admin);
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
    }
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });
});

describe('POST /memories (confirmed add)', () => {
  it('applied → 200 with the memory; audited memory.create as update', async () => {
    const kit = makeApiTestApp();
    const created = makeAdminMemory({
      projectId: PROJECT_A,
      provenance: 'web_ui',
      approved_by: USERS.adminA.userId,
    });
    kit.direct.adminRepo.memories.push(created);
    kit.direct.promote.result = { outcome: 'applied', memoryId: created.id, deduped: false };
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'applied',
      deduped: false,
      memory: { id: created.id, provenance: 'web_ui' },
    });
    const call = kit.direct.staging.calls[0]!;
    expect(call.openedBy).toBe(USERS.adminA.subject);
    expect(call.item.authorIdentity).toBe(USERS.adminA.subject);
    expect(call.branch).toMatch(new RegExp(`^web/${USERS.adminA.userId}/[0-9A-Z]{26}$`));
    expect(kit.direct.promote.calls[0]!.opts).toEqual({
      humanApproved: { approverUserId: USERS.adminA.userId },
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      memoryId: created.id,
      detail: { api: 'memory.create', outcome: 'applied', itemId: 'item-direct-1', deduped: false },
    });
    expect(JSON.stringify(kit.authRepo.accessLogEntries)).not.toContain(UNIT.title);
  });

  it('quarantined → 200 with reason code and quarantine id', async () => {
    const kit = makeApiTestApp();
    kit.direct.promote.result = {
      outcome: 'quarantined',
      itemId: 'item-direct-1',
      quarantineId: 'q-1',
    };
    kit.direct.quarantine.detail = {
      ...DETAIL,
      reasonCode: 'secret_detected',
      criterion: 'pipeline',
    };
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'quarantined',
      quarantineId: 'q-1',
      reasonCode: 'secret_detected',
      criterion: 'pipeline',
    });
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      detail: { api: 'memory.create', outcome: 'quarantined', quarantineId: 'q-1' },
    });
  });

  it('foreign repoId → 404, nothing written', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, repoId: REPO_FOREIGN, confirm: true });
    expect(res.status).toBe(404);
    expect(kit.direct.staging.calls).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('pipeline throw → 500, session abandoned, no audit', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const kit = makeApiTestApp();
    kit.direct.promote.result = new Error('boom');
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, confirm: true });
    expect(res.status).toBe(500);
    expect(kit.direct.promotion.abandonCalls).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('SEC-M2 evaluation unavailable → 503 evaluation_unavailable, session abandoned, no audit', async () => {
    const kit = makeApiTestApp();
    kit.direct.promote.result = { outcome: 'unavailable', itemId: 'item-direct-1' };
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, confirm: true });
    expect(res.status).toBe(503);
    expect(res.text).toBe('{"error":"Service unavailable","code":"evaluation_unavailable"}');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(kit.direct.promotion.abandonCalls).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('SEC-L4 a dedup onto a deprecated memory → 409 duplicate_inactive, no audit', async () => {
    const kit = makeApiTestApp();
    const old = makeAdminMemory({ projectId: PROJECT_A, status: 'deprecated' });
    kit.direct.adminRepo.memories.push(old);
    kit.direct.promote.result = { outcome: 'applied', memoryId: old.id, deduped: true };
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .send({ ...UNIT, confirm: true });
    expect(res.status).toBe(409);
    expect(res.text).toBe('{"error":"Conflict","code":"duplicate_inactive"}');
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it.each([
    ['confirm missing', { ...UNIT }],
    ['confirm false', { ...UNIT, confirm: false }],
    ['confirm "true"', { ...UNIT, confirm: 'true' }],
    ['title 121', { ...UNIT, title: 'x'.repeat(121), confirm: true }],
    ['summary 201', { ...UNIT, summary: 'x'.repeat(201), confirm: true }],
    ['body 2001', { ...UNIT, body: 'x'.repeat(2001), confirm: true }],
    ['empty title', { ...UNIT, title: '', confirm: true }],
    ['unknown fields key (400, not 404)', { ...UNIT, fields: { drivers: 'x' }, confirm: true }],
    ['fields JSON > 2000', { ...UNIT, fields: { symptom: 'x'.repeat(2001) }, confirm: true }],
    ['extra key author_identity', { ...UNIT, author_identity: 'someone', confirm: true }],
    ['repoId not a uuid', { ...UNIT, repoId: 'repo-1', confirm: true }],
    ['bad type', { ...UNIT, type: 'nope', confirm: true }],
  ])('%s → 400, nothing written, no audit', async (_l, body) => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).post(BASE).set('Authorization', admin).send(body);
    expect(res.status).toBe(400);
    expect(res.text).toBe(INVALID_BODY);
    expect(kit.direct.staging.calls).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('a non-JSON content type → 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(BASE)
      .set('Authorization', admin)
      .type('form')
      .send('confirm=true');
    expect(res.status).toBe(400);
  });
});

describe('PUT /memories/:memoryId (confirmed amend)', () => {
  it('current revision → 200 applied; audit memory.amend with the path id', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A, current_revision: 1 });
    kit.direct.adminRepo.memories.push(t);
    kit.direct.promote.result = { outcome: 'applied', memoryId: t.id, deduped: false };
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .send({ ...UNIT, expectedRevision: 1, confirm: true });
    expect(res.status).toBe(200);
    expect(kit.direct.staging.calls[0]!.item).toMatchObject({
      op: 'amend',
      targetMemoryId: t.id,
      targetRevision: 1,
    });
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      memoryId: t.id,
      detail: { api: 'memory.amend', memoryId: t.id },
    });
  });

  it('stale → 409 target_changed, nothing written, no audit', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A, current_revision: 4 });
    kit.direct.adminRepo.memories.push(t);
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .send({ ...UNIT, expectedRevision: 3, confirm: true });
    expect(res.status).toBe(409);
    expect(res.text).toBe('{"error":"Conflict","code":"target_changed"}');
    expect(kit.direct.staging.calls).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('race at apply (pipeline conflict) → 409 and the session is abandoned', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A });
    kit.direct.adminRepo.memories.push(t);
    kit.direct.promote.result = {
      outcome: 'conflict',
      itemId: 'item-direct-1',
      code: 'target_changed',
    };
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .send({ ...UNIT, expectedRevision: 1, confirm: true });
    expect(res.status).toBe(409);
    expect(kit.direct.promotion.abandonCalls).toHaveLength(1);
  });

  it('inactive target → 409 target_inactive; type change → 400; foreign/malformed → 404', async () => {
    const kit = makeApiTestApp();
    const dep = makeAdminMemory({ projectId: PROJECT_A, status: 'deprecated' });
    const act = makeAdminMemory({ projectId: PROJECT_A });
    const foreign = makeAdminMemory({ projectId: PROJECT_B });
    kit.direct.adminRepo.memories.push(dep, act, foreign);
    const put = (id: string, body: object) =>
      request(kit.app).put(`${BASE}/${id}`).set('Authorization', admin).send(body);

    const inactive = await put(dep.id, { ...UNIT, expectedRevision: 1, confirm: true });
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('target_inactive');
    const typeChange = await put(act.id, {
      ...UNIT,
      type: 'pattern',
      fields: {},
      expectedRevision: 1,
      confirm: true,
    });
    expect(typeChange.status).toBe(400);
    expect((await put(foreign.id, { ...UNIT, expectedRevision: 1, confirm: true })).status).toBe(
      404,
    );
    expect((await put('nope', { ...UNIT, expectedRevision: 1, confirm: true })).status).toBe(404);
    expect(kit.direct.staging.calls).toHaveLength(0);
  });

  it('SEC-M2 evaluation unavailable → 503 and the session is abandoned', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A });
    kit.direct.adminRepo.memories.push(t);
    kit.direct.promote.result = { outcome: 'unavailable', itemId: 'item-direct-1' };
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .send({ ...UNIT, expectedRevision: 1, confirm: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Service unavailable', code: 'evaluation_unavailable' });
    expect(kit.direct.promotion.abandonCalls).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it.each([0, -1, 1.5, '3', null])('expectedRevision %s → 400', async (rev) => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A });
    kit.direct.adminRepo.memories.push(t);
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .send({ ...UNIT, expectedRevision: rev, confirm: true });
    expect(res.status).toBe(400);
  });

  it('a non-JSON content type → 400', async () => {
    const kit = makeApiTestApp();
    const t = makeAdminMemory({ projectId: PROJECT_A });
    kit.direct.adminRepo.memories.push(t);
    const res = await request(kit.app)
      .put(`${BASE}/${t.id}`)
      .set('Authorization', admin)
      .type('form')
      .send('confirm=true');
    expect(res.status).toBe(400);
  });
});
