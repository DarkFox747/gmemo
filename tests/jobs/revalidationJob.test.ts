/**
 * revalidation-sweep job (C4, HU-12.1) through the C3 jobs router, wired the
 * same way as src/index.ts: { [REVALIDATION_SWEEP_JOB]: () => lifecycleService.sweep() }
 * over the real LifecycleService and a FakeLifecycleRepository.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeJobsRouter } from '../../src/jobs/jobsRouter.js';
import { LifecycleService } from '../../src/lifecycle/lifecycleService.js';
import { REVALIDATION_SWEEP_JOB } from '../../src/lifecycle/types.js';
import { FakeLifecycleRepository, makeMemory } from '../lifecycle/fakes.js';
import { logger } from '../../src/observability/logger.js';

const TOKEN = 'r'.repeat(40);
const P = '00000000-0000-0000-0000-0000000000a1';
const DAY_MS = 86_400_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function build(enabled: boolean) {
  const repo = new FakeLifecycleRepository([
    makeMemory({ projectId: P, revalidateAt: new Date(Date.now() - DAY_MS) }),
    makeMemory({ projectId: P, type: 'outcome', revalidateAt: new Date(Date.now() - DAY_MS) }),
  ]);
  const lifecycleService = new LifecycleService({ lifecycleRepository: repo });
  const recordJob = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(
    '/internal/jobs',
    makeJobsRouter({
      jobs: { [REVALIDATION_SWEEP_JOB]: () => lifecycleService.sweep() },
      token: TOKEN,
      enabled,
      audit: { recordJob },
    }),
  );
  return { app, repo, recordJob };
}

describe('POST /internal/jobs/revalidation-sweep', () => {
  it('runs the sweep, audits it and returns the JobResult', async () => {
    const { app, repo, recordJob } = build(true);
    const res = await request(app)
      .post('/internal/jobs/revalidation-sweep')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: 'revalidation-sweep', count: 1, detail: { [P]: 1 } });
    expect(recordJob).toHaveBeenCalledWith({
      job: 'revalidation-sweep',
      count: 1,
      detail: { [P]: 1 },
      trigger: 'http',
    });
    expect(repo.memories.map((m) => m.status)).toEqual(['pending_revalidation', 'active']);

    const again = await request(app)
      .post('/internal/jobs/revalidation-sweep')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(again.body).toEqual({ job: 'revalidation-sweep', count: 0, detail: {} });
  });

  it('disabled router → opaque 404 and the sweep never runs', async () => {
    const { app, repo } = build(false);
    const res = await request(app)
      .post('/internal/jobs/revalidation-sweep')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(repo.calls).toHaveLength(0);
  });

  it('a wrong token → opaque 404', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { app, repo } = build(true);
    const res = await request(app)
      .post('/internal/jobs/revalidation-sweep')
      .set('Authorization', `Bearer ${'x'.repeat(40)}`);
    expect(res.status).toBe(404);
    expect(repo.calls).toHaveLength(0);
  });
});
