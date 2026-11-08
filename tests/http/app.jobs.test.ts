/**
 * createApp + /internal/jobs (C3): mounted path works; absent option → no
 * route; nothing under /internal/jobs reaches the dev SPA fallback.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/http/app.js';
import { makeStubAuthServices } from '../auth/fakes.js';
import type { JobsRouterDeps } from '../../src/jobs/jobsRouter.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmemo-jobs-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>gmemo</title>');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function jobs(enabled = true): JobsRouterDeps {
  return {
    jobs: {
      'quarantine-purge': () => Promise.resolve({ job: 'quarantine-purge', count: 0, detail: {} }),
    },
    enabled,
    audit: { recordJob: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('createApp — /internal/jobs', () => {
  it('mounted (open mode under NODE_ENV=development) → 200 JobResult', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    let app;
    try {
      app = createApp(makeStubAuthServices(), { jobs: jobs() });
    } finally {
      process.env.NODE_ENV = orig;
    }
    const res = await request(app).post('/internal/jobs/quarantine-purge');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: 'quarantine-purge', count: 0, detail: {} });
  });

  it('without the jobs option → no route (404)', async () => {
    const app = createApp(makeStubAuthServices());
    expect((await request(app).post('/internal/jobs/quarantine-purge')).status).toBe(404);
  });

  it('never reaches the SPA fallback when webStaticDir is set', async () => {
    for (const options of [{ jobs: jobs(false), webStaticDir: dir }, { webStaticDir: dir }]) {
      const app = createApp(makeStubAuthServices(), options);
      const res = await request(app).get('/internal/jobs/x');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('<title>gmemo</title>');
    }
  });
});
