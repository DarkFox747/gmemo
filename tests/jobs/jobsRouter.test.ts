import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  isJobsEnabled,
  isOpenMode,
  makeJobsRouter,
  type JobResult,
  type JobsRouterDeps,
} from '../../src/jobs/jobsRouter.js';
import { logger } from '../../src/observability/logger.js';

const TOKEN = 't'.repeat(40);
const ORIG_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_ENV;
  vi.restoreAllMocks();
});

describe('isJobsEnabled / isOpenMode (SEC-M3, CR-M2)', () => {
  it.each([
    ['production', undefined, false, false],
    ['test', undefined, false, false],
    [undefined, undefined, false, false],
    ['development', undefined, true, true],
    ['production', TOKEN, true, false],
    ['test', TOKEN, true, false],
    [undefined, TOKEN, true, false],
    ['development', TOKEN, true, false],
  ])('NODE_ENV=%s token=%s → enabled %s, open %s', (env, token, enabled, open) => {
    expect(isJobsEnabled(env, token)).toBe(enabled);
    expect(isOpenMode(env, token)).toBe(open);
  });
});

function build(over: Partial<JobsRouterDeps> = {}) {
  const recordJob = vi.fn().mockResolvedValue(undefined);
  const job = vi.fn<() => Promise<JobResult>>().mockResolvedValue({
    job: 'quarantine-purge',
    count: 2,
    detail: { p1: 2 },
  });
  const deps: JobsRouterDeps = {
    jobs: { 'quarantine-purge': job },
    enabled: true,
    audit: { recordJob },
    ...over,
  };
  const app = express();
  app.use('/internal/jobs', makeJobsRouter(deps));
  // Terminal handler like createApp's (opaque 500).
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'Internal server error' });
    },
  );
  return { app, recordJob, job };
}

const NOT_FOUND = JSON.stringify({ error: 'Not found' });

describe('jobs router — disabled', () => {
  it('404 on every path when disabled', async () => {
    const { app, job } = build({ enabled: false });
    for (const r of [
      request(app).post('/internal/jobs/quarantine-purge'),
      request(app).post('/internal/jobs/quarantine-purge').set('Authorization', `Bearer ${TOKEN}`),
      request(app).get('/internal/jobs/x'),
    ]) {
      const res = await r;
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND);
    }
    expect(job).not.toHaveBeenCalled();
  });
});

describe('jobs router — token mode', () => {
  it.each([
    ['no header', undefined],
    ['wrong token', 'Bearer nope'],
    ['same-length wrong token', `Bearer ${'u'.repeat(40)}`],
    ['Basic scheme', `Basic ${TOKEN}`],
  ])('%s → identical 404, job not run', async (_l, header) => {
    const { app, job, recordJob } = build({ token: TOKEN });
    const req = request(app).post('/internal/jobs/quarantine-purge');
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND);
    expect(job).not.toHaveBeenCalled();
    expect(recordJob).not.toHaveBeenCalled();
  });

  it('right token → 200 JobResult, audited once with trigger http', async () => {
    const { app, recordJob } = build({ token: TOKEN });
    const res = await request(app)
      .post('/internal/jobs/quarantine-purge')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: 'quarantine-purge', count: 2, detail: { p1: 2 } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(recordJob).toHaveBeenCalledTimes(1);
    expect(recordJob).toHaveBeenCalledWith({
      job: 'quarantine-purge',
      count: 2,
      detail: { p1: 2 },
      trigger: 'http',
    });
  });

  it('token mode works under production', async () => {
    process.env.NODE_ENV = 'production';
    const { app } = build({ token: TOKEN });
    const res = await request(app)
      .post('/internal/jobs/quarantine-purge')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe('jobs router — open mode', () => {
  it('runs without a token under NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    const { app } = build();
    expect((await request(app).post('/internal/jobs/quarantine-purge')).status).toBe(200);
  });

  it.each(['test', undefined])('is disabled under NODE_ENV=%s (development only)', async (env) => {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    const { app, job } = build();
    const res = await request(app).post('/internal/jobs/quarantine-purge');
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND);
    expect(job).not.toHaveBeenCalled();
  });

  it('is disabled under NODE_ENV=production (third guard layer)', async () => {
    process.env.NODE_ENV = 'production';
    const { app, job } = build();
    const res = await request(app).post('/internal/jobs/quarantine-purge');
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND);
    expect(job).not.toHaveBeenCalled();
  });
});

describe('jobs router — job name and method', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  it.each(['unknown', '__proto__', 'toString', 'QUARANTINE-PURGE', 'constructor', 'a'.repeat(65)])(
    'POST /%s → 404',
    async (name) => {
      const { app } = build();
      const res = await request(app).post(`/internal/jobs/${name}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe(NOT_FOUND);
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('GET → 404', async () => {
    const { app, job } = build();
    const res = await request(app).get('/internal/jobs/quarantine-purge');
    expect(res.status).toBe(404);
    expect(res.text).toBe(NOT_FOUND);
    expect(job).not.toHaveBeenCalled();
  });

  it('a throwing job → 500 and no audit', async () => {
    const { app, job, recordJob } = build();
    job.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/internal/jobs/quarantine-purge');
    expect(res.status).toBe(500);
    expect(recordJob).not.toHaveBeenCalled();
  });

  it('an audit failure → 500', async () => {
    const { app, recordJob } = build();
    recordJob.mockRejectedValueOnce(new Error('audit down'));
    expect((await request(app).post('/internal/jobs/quarantine-purge')).status).toBe(500);
  });
});

describe('jobs router — rate limit and failed-token logging (SEC-L4)', () => {
  it('more than 10 requests per minute → opaque 429', async () => {
    const { app } = build({ token: TOKEN });
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/internal/jobs/quarantine-purge')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
    }
    const res = await request(app)
      .post('/internal/jobs/quarantine-purge')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too Many Requests' });
  });

  it('a rejected token is warned about without logging the token', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { app } = build({ token: TOKEN });
    const bad = 'Bearer wrong-token-value-1234567890';
    expect(
      (await request(app).post('/internal/jobs/quarantine-purge').set('Authorization', bad)).status,
    ).toBe(404);
    expect((await request(app).post('/internal/jobs/quarantine-purge')).status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[jobs] rejected request: missing or invalid token');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('wrong-token-value');
    expect(logged).not.toContain(TOKEN);
  });

  it('a correct token is not warned about', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { app } = build({ token: TOKEN });
    await request(app)
      .post('/internal/jobs/quarantine-purge')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(warn).not.toHaveBeenCalled();
  });
});
