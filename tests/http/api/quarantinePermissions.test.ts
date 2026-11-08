/**
 * HU-10.4 opacity matrix for the quarantine routes: every foreign shape gets the
 * byte-identical 404 on list/detail/restore with no access_log row and no
 * restore claim; a member who is not the author sees no foreign rows; a
 * non-admin author cannot restore, even with an invalid body (404, not 400).
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Test } from 'supertest';
import type express from 'express';
import {
  ARCHIVED_PROJECT,
  PROJECT_A,
  PROJECT_B,
  RANDOM_PROJECT,
  USERS,
  bearer,
  makeApiTestApp,
} from './helpers.js';
import { ROW } from '../../quarantine/fakes.js';

const NOT_FOUND_BODY = '{"error":"Not found"}';
const ID = ROW.id;

type Route = { name: string; call: (app: express.Express, projectId: string, id?: string) => Test };

const ROUTES: Route[] = [
  { name: 'list', call: (app, p) => request(app).get(`/api/v1/projects/${p}/quarantine`) },
  {
    name: 'detail',
    call: (app, p, id = ID) => request(app).get(`/api/v1/projects/${p}/quarantine/${id}`),
  },
  {
    name: 'restore',
    call: (app, p, id = ID) =>
      request(app).post(`/api/v1/projects/${p}/quarantine/${id}/restore`).send({}),
  },
];

const FOREIGN: Array<{ who: string; user: { subject: string }; project: string }> = [
  { who: 'admin of another project', user: USERS.adminB, project: PROJECT_A },
  { who: 'platform_admin without membership', user: USERS.platformAdmin, project: PROJECT_A },
  { who: 'disabled admin', user: USERS.disabledAdminA, project: PROJECT_A },
  { who: 'unknown subject', user: { subject: 'sub-nobody' }, project: PROJECT_A },
  { who: 'admin A on project B', user: USERS.adminA, project: PROJECT_B },
  { who: 'admin A on an archived project', user: USERS.adminA, project: ARCHIVED_PROJECT },
  { who: 'admin A on a random project id', user: USERS.adminA, project: RANDOM_PROJECT },
  { who: 'admin A on a malformed project id', user: USERS.adminA, project: 'not-a-uuid' },
];

describe('quarantine opacity matrix (HU-10.4)', () => {
  for (const route of ROUTES) {
    for (const d of FOREIGN) {
      it(`${route.name}: ${d.who} → identical 404, no audit, no claim`, async () => {
        const kit = makeApiTestApp();
        const res = await route.call(kit.app, d.project).set('Authorization', bearer(d.user));
        expect(res.status).toBe(404);
        expect(res.text).toBe(NOT_FOUND_BODY);
        expect(kit.authRepo.accessLogEntries).toHaveLength(0);
        expect(kit.quarantineRepo.claimCalls).toHaveLength(0);
      });
    }
  }

  for (const route of ROUTES.filter((r) => r.name !== 'list')) {
    it(`${route.name}: malformed quarantine id → identical 404`, async () => {
      const kit = makeApiTestApp();
      const res = await route
        .call(kit.app, PROJECT_A, 'nope')
        .set('Authorization', bearer(USERS.adminA));
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
      expect(kit.authRepo.accessLogEntries).toHaveLength(0);
    });
  }

  it.each([
    ['contributor', USERS.contributorA],
    ['viewer', USERS.viewerA],
    ['service_agent', USERS.serviceA],
  ])(
    '%s (not the author): list → 200 with no foreign rows; detail and restore → 404',
    async (_w, user) => {
      const kit = makeApiTestApp();
      kit.quarantineRepo.author = 'someone-else';
      const list = await request(kit.app)
        .get(`/api/v1/projects/${PROJECT_A}/quarantine`)
        .set('Authorization', bearer(user));
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([]);

      for (const route of ROUTES.filter((r) => r.name !== 'list')) {
        const res = await route.call(kit.app, PROJECT_A).set('Authorization', bearer(user));
        expect(res.status).toBe(404);
        expect(res.text).toBe(NOT_FOUND_BODY);
      }
      expect(kit.quarantineRepo.claimCalls).toHaveLength(0);
    },
  );

  it('the author (contributor, not admin) cannot restore → 404', async () => {
    const kit = makeApiTestApp();
    kit.quarantineRepo.author = USERS.contributorA.subject;
    const res = await request(kit.app)
      .post(`/api/v1/projects/${PROJECT_A}/quarantine/${ID}/restore`)
      .set('Authorization', bearer(USERS.contributorA))
      .send({});
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
    expect(kit.quarantineRepo.claimCalls).toHaveLength(0);
    expect(kit.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('non-admin restore with an invalid body or content type → 404, not 400', async () => {
    const kit = makeApiTestApp();
    const base = `/api/v1/projects/${PROJECT_A}/quarantine/${ID}/restore`;
    const bad = await request(kit.app)
      .post(base)
      .set('Authorization', bearer(USERS.contributorA))
      .send({ x: 1 });
    const form = await request(kit.app)
      .post(base)
      .set('Authorization', bearer(USERS.viewerA))
      .type('form')
      .send('a=1');
    for (const res of [bad, form]) {
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND_BODY);
    }
  });

  it('unauthenticated → 401 on every route', async () => {
    const kit = makeApiTestApp();
    for (const route of ROUTES) {
      expect((await route.call(kit.app, PROJECT_A)).status).toBe(401);
    }
  });

  it('unknown path under /quarantine → 404 (never reaches other routers)', async () => {
    const kit = makeApiTestApp();
    const res = await request(kit.app)
      .get(`/api/v1/projects/${PROJECT_A}/quarantine/${ID}/extra`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND_BODY);
  });
});
