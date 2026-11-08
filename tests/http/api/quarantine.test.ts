/**
 * Quarantine routes (C3, HU-10.1/10.2): DTO shape, reason filter validation,
 * restore outcomes, restore audit detail, audit only after success.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { PROJECT_A, USERS, bearer, makeApiTestApp } from './helpers.js';
import { ROW } from '../../quarantine/fakes.js';
import { logger } from '../../../src/observability/logger.js';

const BASE = `/api/v1/projects/${PROJECT_A}/quarantine`;
const ID = ROW.id;

afterEach(() => vi.restoreAllMocks());

describe('GET /quarantine', () => {
  it('admin → 200 list DTO, audited as quarantine.list (read)', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app).get(BASE).set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: ID,
          reasonCode: 'judge_rejected',
          criterion: 'judge',
          op: 'add',
          type: 'gotcha',
          title: 'Deploy issue',
          excerpt: 'Deploy failed with [REDACTADO]',
          quarantinedAt: '2026-11-01T10:00:00.000Z',
          daysUntilExpiry: 54,
        },
      ],
      truncated: false,
    });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'read',
      projectId: PROJECT_A,
      detail: { api: 'quarantine.list', resultCount: 1, userId: USERS.adminA.userId },
    });
  });

  it('reason filter is passed through and audited as filter', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .get(`${BASE}?reason=secret_detected&limit=5`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(kit.quarantineRepo.listCalls[0]!.q).toEqual({ reason: 'secret_detected', limit: 5 });
    expect(kit.authRepo.accessLogEntries[0]!.detail).toMatchObject({ filter: 'secret_detected' });
  });

  it.each(['reason=foo', 'limit=0', 'limit=201', 'extra=1'])(
    '%s → 400 for a member',
    async (qs) => {
      const kit = makeApiTestApp();
      const res = await request(kit.app)
        .get(`${BASE}?${qs}`)
        .set('Authorization', bearer(USERS.contributorA));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
      expect(kit.authRepo.accessLogEntries).toHaveLength(0);
    },
  );

  it('a contributor lists only own rows (non-admin viewer)', async () => {
    const kit = makeApiTestApp();
    kit.quarantineRepo.author = USERS.contributorA.subject;
    const res = await request(kit.app).get(BASE).set('Authorization', bearer(USERS.contributorA));
    expect(res.body.items).toHaveLength(1);
    expect(kit.quarantineRepo.listCalls[0]!.v).toEqual({
      isAdmin: false,
      subject: USERS.contributorA.subject,
    });
  });
});

describe('GET /quarantine/:id', () => {
  it('admin → detail with canRestore true; audited with quarantineId', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .get(`${BASE}/${ID}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ID,
      judgeReason: 'specificity',
      author: 'Dev One',
      canRestore: true,
      expiresAt: '2026-12-31T10:00:00.000Z',
      originBranch: 'feat/x',
      originPr: 7,
      related: null,
      summary: 'Summary',
      body: 'Deploy failed with [REDACTADO]',
      fields: {},
    });
    expect(kit.authRepo.accessLogEntries[0]!.detail).toMatchObject({
      api: 'quarantine.read',
      quarantineId: ID,
    });
  });

  it('author (non-admin) → detail with canRestore false', async () => {
    const kit = makeApiTestApp();
    kit.quarantineRepo.author = USERS.contributorA.subject;
    const res = await request(kit.app)
      .get(`${BASE}/${ID}`)
      .set('Authorization', bearer(USERS.contributorA));
    expect(res.status).toBe(200);
    expect(res.body.canRestore).toBe(false);
  });

  it('missing row → 404, not audited', async () => {
    const kit = makeApiTestApp();
    kit.quarantineRepo.detail = null;
    const res = await request(kit.app)
      .get(`${BASE}/${ID}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(404);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });
});

describe('POST /quarantine/:id/restore', () => {
  const restore = (kit: ReturnType<typeof makeApiTestApp>) =>
    request(kit.app).post(`${BASE}/${ID}/restore`).set('Authorization', bearer(USERS.adminA));

  it('applied → 200 {outcome, memoryId}; audited as update with ids only', async () => {
    const kit = makeApiTestApp();
    const res = await restore(kit).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'applied', memoryId: 'mem-1' });
    expect(kit.authRepo.accessLogEntries).toHaveLength(1);
    expect(kit.authRepo.accessLogEntries[0]).toMatchObject({
      action: 'update',
      memoryId: 'mem-1',
      detail: {
        api: 'quarantine.restore',
        quarantineId: ID,
        itemId: 'item-restore',
        outcome: 'applied',
        memoryId: 'mem-1',
        userId: USERS.adminA.userId,
      },
    });
    expect(kit.quarantineRepo.claimCalls[0]).toMatchObject({
      restoredByUserId: USERS.adminA.userId,
    });
  });

  it('queued → 200 {outcome, itemId}', async () => {
    const kit = makeApiTestApp();
    kit.quarantinePromote.result = { outcome: 'queued', itemId: 'item-restore' };
    const res = await restore(kit).send({});
    expect(res.body).toEqual({ outcome: 'queued', itemId: 'item-restore' });
  });

  it('quarantined → 200 {outcome, quarantineId}; audit carries newQuarantineId', async () => {
    const kit = makeApiTestApp();
    kit.quarantinePromote.result = {
      outcome: 'quarantined',
      itemId: 'item-restore',
      quarantineId: 'q-new',
    };
    const res = await restore(kit).send({});
    expect(res.body).toEqual({ outcome: 'quarantined', quarantineId: 'q-new' });
    expect(kit.authRepo.accessLogEntries[0]!.detail).toMatchObject({
      outcome: 'quarantined',
      newQuarantineId: 'q-new',
    });
  });

  it('already restored (claim not_found) → 404, not audited', async () => {
    const kit = makeApiTestApp();
    kit.quarantineRepo.claimResult = { status: 'not_found' };
    const res = await restore(kit).send({});
    expect(res.status).toBe(404);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('no body with a JSON content type → 200 (defaults)', async () => {
    const kit = makeApiTestApp();
    const res = await restore(kit).set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
  });

  it('non-JSON content type or unknown body keys → 400 for the admin', async () => {
    const kit = makeApiTestApp();
    expect((await restore(kit).type('form').send('a=1')).status).toBe(400);
    expect((await restore(kit).send({ force: true })).status).toBe(400);
    expect(kit.quarantineRepo.claimCalls).toHaveLength(0);
  });

  it('audit failure after the restore → 500 and logged with the id', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const kit = makeApiTestApp();
    kit.authRepo.insertAccessLog = () => Promise.reject(new Error('db down'));
    const res = await restore(kit).send({});
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledWith('[api] audit failed after committed quarantine restore', {
      quarantineId: ID,
      errorName: 'Error',
    });
  });

  it('pipeline failure → 500, not audited', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const kit = makeApiTestApp();
    kit.quarantinePromote.result = new Error('boom');
    const res = await restore(kit).send({});
    expect(res.status).toBe(500);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });
});
