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
