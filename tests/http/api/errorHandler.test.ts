/**
 * apiErrorHandler — the REST error vocabulary (design § REST error model).
 * Each mapping row with exact bodies; malformed JSON on /api → 400;
 * non-AppError → 500 + logged; headersSent → delegated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiErrorHandler } from '../../../src/http/api/errorHandler.js';
import { AppError, ErrorCode } from '../../../src/errors/appError.js';
import { logger } from '../../../src/observability/logger.js';

function appThrowing(err: unknown): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/api/x', () => {
    throw err;
  });
  app.post('/api/echo', (req, res) => {
    res.json({ ok: true, body: req.body as unknown });
  });
  app.use('/api', apiErrorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiErrorHandler mapping', () => {
  it('UNAUTHENTICATED → 401 {"error":"Unauthorized"} + WWW-Authenticate: Bearer', async () => {
    const res = await request(appThrowing(new AppError(ErrorCode.UNAUTHENTICATED))).get('/api/x');
    expect(res.status).toBe(401);
    expect(res.text).toBe('{"error":"Unauthorized"}');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ErrorCode.PERMISSION_DENIED,
    ErrorCode.NOT_FOUND,
    ErrorCode.CONTEXT_UNAVAILABLE,
    ErrorCode.INVALID_REFERENCE,
  ])('%s → 404 {"error":"Not found"}', async (code) => {
    const res = await request(appThrowing(new AppError(code))).get('/api/x');
    expect(res.status).toBe(404);
    expect(res.text).toBe('{"error":"Not found"}');
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('INVALID_REQUEST → 400 {"error":"Invalid request"}', async () => {
    const res = await request(appThrowing(new AppError(ErrorCode.INVALID_REQUEST))).get('/api/x');
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
  });

  it('malformed JSON body on /api → 400 without echoing the input', async () => {
    const res = await request(appThrowing(new Error('unused')))
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send('{"secret-ish": ');
    expect(res.status).toBe(400);
    expect(res.text).toBe('{"error":"Invalid request"}');
  });

  it('AppError(INTERNAL) → 500 and logged', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new AppError(ErrorCode.INTERNAL))).get('/api/x');
    expect(res.status).toBe(500);
    expect(res.text).toBe('{"error":"Internal server error"}');
    expect(spy).toHaveBeenCalledWith('[api] Unhandled error', expect.anything());
  });

  it('non-AppError → 500 with the generic body (no message leak) and logged', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new Error('db password=hunter2'))).get('/api/x');
    expect(res.status).toBe(500);
    expect(res.text).toBe('{"error":"Internal server error"}');
    expect(res.text).not.toContain('hunter2');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('delegates to the next error handler when headers were already sent', async () => {
    const app = express();
    app.get('/api/x', (_req, res, next) => {
      res.status(200).write('partial');
      next(new Error('late'));
    });
    app.use('/api', apiErrorHandler);
    const terminal = vi.fn(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.end();
      },
    );
    app.use(terminal);
    const res = await request(app).get('/api/x');
    expect(res.status).toBe(200);
    expect(terminal).toHaveBeenCalledTimes(1);
  });
});
