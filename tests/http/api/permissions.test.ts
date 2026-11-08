/**
 * HU-07.5 opacity matrix: every non-admin shape, a foreign project, a random
 * project id and a malformed project id get the byte-identical 404 on all four
 * review-queue routes, with no access_log row and no service call.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Test } from 'supertest';
import type express from 'express';
import {
  ARCHIVED_PROJECT,
  ITEM_ID,
  PROJECT_A,
  PROJECT_B,
  RANDOM_PROJECT,
  USERS,
  bearer,
  makeApiTestApp,
} from './helpers.js';
import { makeItem } from '../../review/fakes.js';

const NOT_FOUND_BODY = '{"error":"Not found"}';

type Route = { name: string; call: (app: express.Express, projectId: string) => Test };

const ROUTES: Route[] = [
  { name: 'list', call: (app, p) => request(app).get(`/api/v1/projects/${p}/review-queue`) },
  {
    name: 'detail',
    call: (app, p) => request(app).get(`/api/v1/projects/${p}/review-queue/${ITEM_ID}`),
  },
  {
    name: 'approve',
    call: (app, p) =>
      request(app).post(`/api/v1/projects/${p}/review-queue/${ITEM_ID}/approve`).send({}),
  },
  {
    name: 'reject',
    call: (app, p) =>
      request(app)
        .post(`/api/v1/projects/${p}/review-queue/${ITEM_ID}/reject`)
        .send({ reason: 'too vague' }),
  },
];

const DENIED: Array<{ who: string; user: { subject: string }; project: string }> = [
  { who: 'contributor', user: USERS.contributorA, project: PROJECT_A },
  { who: 'viewer', user: USERS.viewerA, project: PROJECT_A },
  { who: 'service_agent', user: USERS.serviceA, project: PROJECT_A },
  { who: 'admin of another project', user: USERS.adminB, project: PROJECT_A },
  { who: 'platform_admin without membership', user: USERS.platformAdmin, project: PROJECT_A },
  { who: 'disabled admin', user: USERS.disabledAdminA, project: PROJECT_A },
  { who: 'unknown subject', user: { subject: 'sub-nobody' }, project: PROJECT_A },
  { who: 'admin A on project B (exists)', user: USERS.adminA, project: PROJECT_B },
  { who: 'admin A on an archived project', user: USERS.adminA, project: ARCHIVED_PROJECT },
  { who: 'admin A on a random project id', user: USERS.adminA, project: RANDOM_PROJECT },
  { who: 'admin A on a malformed project id', user: USERS.adminA, project: 'not-a-uuid' },
];

describe('review-queue opacity matrix (HU-07.5)', () => {
  for (const route of ROUTES) {
    for (const d of DENIED) {
      it(`${route.name}: ${d.who} → identical 404, no audit, no service call`, async () => {
        const kit = makeApiTestApp();
        kit.queueRepo.item = makeItem({ id: ITEM_ID });
        const res = await route.call(kit.app, d.project).set('Authorization', bearer(d.user));
        expect(res.status).toBe(404);
        expect(res.text).toBe(NOT_FOUND_BODY);
        expect(kit.authRepo.accessLogEntries).toHaveLength(0);
        expect(kit.promotionRepo.approveInputs).toHaveLength(0);
        expect(kit.promotionRepo.rejectInputs).toHaveLength(0);
      });
    }
  }

  it('non-admin with an invalid body gets 404, not 400 (no validation oracle)', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`/api/v1/projects/${PROJECT_A}/review-queue/${ITEM_ID}/reject`)
      .set('Authorization', bearer(USERS.viewerA))
      .send({ reason: 'x', extra: true });
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });

  it('non-admin posting form-encoded gets 404, not 400 (authz before content-type)', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`/api/v1/projects/${PROJECT_A}/review-queue/${ITEM_ID}/approve`)
      .set('Authorization', bearer(USERS.viewerA))
      .type('form')
      .send('markRelatedSuperseded=true');
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });

  it('non-admin with an invalid query gets 404, not 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .get(`/api/v1/projects/${PROJECT_A}/review-queue?filter=bogus`)
      .set('Authorization', bearer(USERS.contributorA));
    expect(res.status).toBe(404);
  });

  it('control: the project admin passes on its own project', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .get(`/api/v1/projects/${PROJECT_A}/review-queue`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C4 memory lifecycle routes: same opacity matrix, plus a malformed memory id.
// ---------------------------------------------------------------------------

const MEMORY_ID = '22222222-3333-4444-8555-666666666666';

const MEMORY_ROUTES: Route[] = [
  { name: 'memories list', call: (app, p) => request(app).get(`/api/v1/projects/${p}/memories`) },
  {
    name: 'memory confirm',
    call: (app, p) => request(app).post(`/api/v1/projects/${p}/memories/${MEMORY_ID}/confirm`).send({}),
  },
  {
    name: 'memory retire',
    call: (app, p) =>
      request(app)
        .post(`/api/v1/projects/${p}/memories/${MEMORY_ID}/retire`)
        .send({ reason: 'obsolete now' }),
  },
  {
    name: 'retire-by-pr',
    call: (app, p) =>
      request(app)
        .post(`/api/v1/projects/${p}/memories/retire-by-pr`)
        .send({ originPr: 42, reason: 'reverted PR' }),
  },
];

describe('memory lifecycle opacity matrix (C4)', () => {
  for (const route of MEMORY_ROUTES) {
    for (const d of DENIED) {
      it(`${route.name}: ${d.who} → identical 404, no audit, no service call`, async () => {
        const kit = makeApiTestApp();
        const res = await route.call(kit.app, d.project).set('Authorization', bearer(d.user));
        expect(res.status).toBe(404);
        expect(res.text).toBe(NOT_FOUND_BODY);
        expect(kit.authRepo.accessLogEntries).toHaveLength(0);
        expect(kit.lifecycleRepo.calls).toHaveLength(0);
      });
    }
  }

  for (const action of ['confirm', 'retire']) {
    it(`${action}: a malformed memory id → identical 404 for the admin, no service call`, async () => {
      const kit = makeApiTestApp();
      const res = await request(kit.app)
        .post(`/api/v1/projects/${PROJECT_A}/memories/not-a-uuid/${action}`)
        .set('Authorization', bearer(USERS.adminA))
        .send({ reason: 'obsolete now' });
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
      expect(kit.lifecycleRepo.calls).toHaveLength(0);
    });
  }

  it('non-admin with an invalid retire body gets 404, not 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`/api/v1/projects/${PROJECT_A}/memories/${MEMORY_ID}/retire`)
      .set('Authorization', bearer(USERS.viewerA))
      .send({ reason: 'x' });
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });
});

// ---------------------------------------------------------------------------
// C5 direct memory management (HU-13.5): the same matrix on all 5 routes.
// ---------------------------------------------------------------------------

const VALID_UNIT = {
  type: 'gotcha',
  title: 'Pool exhaustion',
  summary: 'pg pool starves under burst.',
  body: 'Raise PGPOOL_MAX in src/db/pool.ts.',
  fields: {},
};

const DIRECT_ROUTES: Route[] = [
  {
    name: 'direct list',
    call: (app, p) => request(app).get(`/api/v1/projects/${p}/memories?status=active`),
  },
  {
    name: 'direct detail',
    call: (app, p) => request(app).get(`/api/v1/projects/${p}/memories/${MEMORY_ID}`),
  },
  {
    name: 'direct preview',
    call: (app, p) =>
      request(app).post(`/api/v1/projects/${p}/memories/preview`).send({ op: 'add', ...VALID_UNIT }),
  },
  {
    name: 'direct create',
    call: (app, p) =>
      request(app).post(`/api/v1/projects/${p}/memories`).send({ ...VALID_UNIT, confirm: true }),
  },
  {
    name: 'direct amend',
    call: (app, p) =>
      request(app)
        .put(`/api/v1/projects/${p}/memories/${MEMORY_ID}`)
        .send({ ...VALID_UNIT, expectedRevision: 1, confirm: true }),
  },
];

describe('direct memory management opacity matrix (C5, HU-13.5)', () => {
  for (const route of DIRECT_ROUTES) {
    for (const d of DENIED) {
      it(`${route.name}: ${d.who} → identical 404, no audit, no service call`, async () => {
        const kit = makeApiTestApp();
        const res = await route.call(kit.app, d.project).set('Authorization', bearer(d.user));
        expect(res.status).toBe(404);
        expect(res.text).toBe(NOT_FOUND_BODY);
        expect(kit.authRepo.accessLogEntries).toHaveLength(0);
        expect(kit.direct.adminRepo.calls).toHaveLength(0);
        expect(kit.direct.staging.calls).toHaveLength(0);
        expect(kit.direct.promote.calls).toHaveLength(0);
        expect(kit.direct.judge.evaluateCalls).toHaveLength(0);
      });
    }
  }

  it('contributor with an invalid create body gets 404, not 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .post(`/api/v1/projects/${PROJECT_A}/memories`)
      .set('Authorization', bearer(USERS.contributorA))
      .send({ title: '', confirm: false, author_identity: 'x' });
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });

  it('viewer with a form-encoded amend gets 404, not 400', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .put(`/api/v1/projects/${PROJECT_A}/memories/${MEMORY_ID}`)
      .set('Authorization', bearer(USERS.viewerA))
      .type('form')
      .send('confirm=true');
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });
});
