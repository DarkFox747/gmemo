/**
 * web-session-reaper job (C5 SEC-M1) through the C3 jobs router, wired the same
 * way as src/index.ts: { [WEB_SESSION_REAPER_JOB]: () => reapStaleWebSessions(repo) }
 * over a recording repository fake.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { logger } from '../../src/observability/logger.js';
import { makeJobsRouter } from '../../src/jobs/jobsRouter.js';
import {
  WEB_SESSION_MAX_AGE_MINUTES,
  WEB_SESSION_REAPER_JOB,
  reapStaleWebSessions,
} from '../../src/memory/webSessionReaper.js';

const TOKEN = 'w'.repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});
const P = '00000000-0000-0000-0000-0000000000a1';
const Q = '00000000-0000-0000-0000-0000000000b1';

class RecordingReaperRepo {
  readonly calls: number[] = [];
  constructor(public result: Array<{ projectId: string; count: number }>) {}
  reapStaleWebSessions(maxAgeMinutes: number) {
    this.calls.push(maxAgeMinutes);
    const r = this.result;
    this.result = [];
    return Promise.resolve(r);
  }
}

describe('reapStaleWebSessions', () => {
  it('asks for sessions older than 5 minutes and sums per project', async () => {
    const repo = new RecordingReaperRepo([
      { projectId: P, count: 2 },
      { projectId: Q, count: 1 },
    ]);
    expect(await reapStaleWebSessions(repo)).toEqual({
      job: 'web-session-reaper',
      count: 3,
      detail: { [P]: 2, [Q]: 1 },
    });
    expect(repo.calls).toEqual([5]);
    expect(WEB_SESSION_MAX_AGE_MINUTES).toBe(5);
  });
});

describe('POST /internal/jobs/web-session-reaper', () => {
  it('runs the reaper, audits it and returns the JobResult; a re-run reaps nothing', async () => {
    const repo = new RecordingReaperRepo([{ projectId: P, count: 1 }]);
    const recordJob = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(
      '/internal/jobs',
      makeJobsRouter({
        jobs: { [WEB_SESSION_REAPER_JOB]: () => reapStaleWebSessions(repo) },
        token: TOKEN,
        enabled: true,
        audit: { recordJob },
      }),
    );
    const res = await request(app)
      .post('/internal/jobs/web-session-reaper')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: 'web-session-reaper', count: 1, detail: { [P]: 1 } });
    expect(recordJob).toHaveBeenCalledWith({
      job: 'web-session-reaper',
      count: 1,
      detail: { [P]: 1 },
      trigger: 'http',
    });
    const again = await request(app)
      .post('/internal/jobs/web-session-reaper')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(again.body).toEqual({ job: 'web-session-reaper', count: 0, detail: {} });
  });

  it('without the token → opaque 404 and the reaper never runs', async () => {
    const repo = new RecordingReaperRepo([]);
    const app = express();
    app.use(
      '/internal/jobs',
      makeJobsRouter({
        jobs: { [WEB_SESSION_REAPER_JOB]: () => reapStaleWebSessions(repo) },
        token: TOKEN,
        enabled: true,
        audit: { recordJob: vi.fn() },
      }),
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const res = await request(app).post('/internal/jobs/web-session-reaper');
    expect(res.status).toBe(404);
    expect(repo.calls).toHaveLength(0);
  });
});
