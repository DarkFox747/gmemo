import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { makeStubAuthServices } from './auth/fakes.js';

/**
 * T040: Health endpoint smoke test.
 *
 * Creates the Express app without starting a server (supertest drives the
 * in-process handler) and asserts the /health route returns exactly
 * { status: "ok" } with HTTP 200.
 *
 * createApp(services) now requires boot-time AuthServices singletons
 * (auth-two-gate change). The health endpoint itself is unauthenticated, so
 * stub services that always succeed are sufficient here.
 */
describe('GET /health', () => {
  it('returns 200 with body { status: "ok" }', async () => {
    const app = createApp(makeStubAuthServices());

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
