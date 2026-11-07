/**
 * T007 — Security hardening HTTP integration tests.
 *
 * Covers:
 *  (a) Rate limiting: ENABLED via options bag + low max → 429 with opaque body
 *      and RateLimit-* standard headers on the N+1 request.
 *  (b) Helmet headers present; X-Powered-By absent on all responses.
 *  (c) Per-IP keying: distinct X-Forwarded-For values get distinct buckets
 *      (relies on trust proxy = 1 so XFF is used as the IP key).
 *  (d) Existing tests are unaffected: limiter is OFF by default (no options).
 *
 * All services are faked — no real DB. supertest drives the Express app
 * assembled via createApp() with the options bag.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/app.js';
import { makeStubAuthServices } from '../auth/fakes.js';

// ---------------------------------------------------------------------------
// Helper — builds an app with rate limiting enabled and tiny limits so tests
// can exhaust the bucket with just a couple of requests.
// ---------------------------------------------------------------------------

function makeRateLimitedApp(mcpMax = 2, promoteMax = 2) {
  return createApp(makeStubAuthServices(), {
    rateLimit: {
      enabled: true,
      mcpWindowMs: 60_000,
      mcpMax,
      promoteWindowMs: 60_000,
      promoteMax,
    },
  });
}

// ---------------------------------------------------------------------------
// (a) Rate limiting: exceeding limit → 429 + opaque body + RateLimit-* headers
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('/mcp: N requests succeed, N+1 returns 429 with opaque body', async () => {
    const app = makeRateLimitedApp(1, 10);

    // First request — within limit (POST /mcp returns 200 from the MCP stub)
    const first = await request(app)
      .post('/mcp')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({});
    // The MCP handler may return various status codes; we only care it is NOT 429.
    expect(first.status).not.toBe(429);

    // Second request — exceeds limit of 1 → 429
    const second = await request(app)
      .post('/mcp')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({});
    expect(second.status).toBe(429);
    // Opaque body — no tenant, resource, or bucket detail
    expect(second.body).toEqual({ error: 'Too Many Requests' });
  });

  it('/mcp: 429 response carries RateLimit-* standard headers', async () => {
    const app = makeRateLimitedApp(1, 10);

    // Exhaust the bucket
    await request(app).post('/mcp').set('X-Forwarded-For', '10.0.0.2').send({});
    const res = await request(app).post('/mcp').set('X-Forwarded-For', '10.0.0.2').send({});

    expect(res.status).toBe(429);
    // At least one RateLimit-* header must be present (standardHeaders: 'draft-7')
    const headers = Object.keys(res.headers).map((h) => h.toLowerCase());
    const hasRateLimitHeader = headers.some((h) => h.startsWith('ratelimit'));
    expect(hasRateLimitHeader).toBe(true);
  });

  it('/promote: N requests succeed, N+1 returns 429', async () => {
    const app = makeRateLimitedApp(10, 1);

    // First request — within limit; /promote will likely 500 due to stub auth
    // but must NOT be 429.
    const first = await request(app)
      .post('/promote')
      .set('X-Forwarded-For', '10.0.0.3')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ repo: 'acme/billing', source_branch: 'main' });
    expect(first.status).not.toBe(429);

    // Second request — exceeds limit of 1 → 429
    const second = await request(app)
      .post('/promote')
      .set('X-Forwarded-For', '10.0.0.3')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ repo: 'acme/billing', source_branch: 'main' });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: 'Too Many Requests' });
  });
});

// ---------------------------------------------------------------------------
// (b) Helmet headers present; X-Powered-By absent
// ---------------------------------------------------------------------------

describe('helmet security headers', () => {
  it('GET /health response has X-Content-Type-Options header set by helmet', async () => {
    // Use default app (no rate limiting needed for header checks)
    const app = createApp(makeStubAuthServices());
    const res = await request(app).get('/health');
    // helmet sets x-content-type-options: nosniff
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /health response has Strict-Transport-Security header set by helmet', async () => {
    const app = createApp(makeStubAuthServices());
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('GET /health response does NOT expose X-Powered-By', async () => {
    const app = createApp(makeStubAuthServices());
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('POST /mcp response has helmet headers and no X-Powered-By', async () => {
    const app = createApp(makeStubAuthServices());
    const res = await request(app).post('/mcp').send({});
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Per-IP keying — distinct XFF values get distinct buckets
// ---------------------------------------------------------------------------

describe('per-IP rate limit keying', () => {
  it('two distinct XFF IPs have independent buckets (trust proxy = 1)', async () => {
    // max=1 so the second request from the SAME IP hits 429.
    const app = makeRateLimitedApp(1, 10);

    // IP A: first request ok, second blocked
    await request(app).post('/mcp').set('X-Forwarded-For', '10.1.0.1').send({});
    const blockedA = await request(app).post('/mcp').set('X-Forwarded-For', '10.1.0.1').send({});
    expect(blockedA.status).toBe(429);

    // IP B: first request is still ok (separate bucket)
    const okB = await request(app).post('/mcp').set('X-Forwarded-For', '10.1.0.2').send({});
    expect(okB.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// (H1 regression) Right-most XFF entry is the rate-limit key (ALB-appended,
// unforgeable). Requests that share the SAME right-most entry share a bucket
// regardless of the left (client-controlled) portion of XFF.
// ---------------------------------------------------------------------------

describe('right-most XFF keying (H1 regression)', () => {
  it('two requests sharing the same right-most XFF entry share a bucket', async () => {
    // max=1 so the second request from the SAME right-most IP hits 429.
    // Both headers have DIFFERENT left entries but THE SAME right-most entry (10.1.0.99).
    // A rotating left value must NOT grant a fresh bucket — only the right-most matters.
    const app = makeRateLimitedApp(1, 10);

    // First request: left=10.1.0.1, right-most=10.1.0.99 — within limit
    const first = await request(app)
      .post('/mcp')
      .set('X-Forwarded-For', '10.1.0.1, 10.1.0.99')
      .send({});
    expect(first.status).not.toBe(429);

    // Second request: left=10.2.0.1 (different!), right-most=10.1.0.99 (same)
    // Must share the bucket from the first request → 429
    const second = await request(app)
      .post('/mcp')
      .set('X-Forwarded-For', '10.2.0.1, 10.1.0.99')
      .send({});
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: 'Too Many Requests' });
  });
});

// ---------------------------------------------------------------------------
// (d) Existing behaviour: limiter OFF by default — no 429 without options bag
// ---------------------------------------------------------------------------

describe('rate limiting disabled by default', () => {
  it('many requests to /mcp without options bag are never 429', async () => {
    const app = createApp(makeStubAuthServices()); // no options → disabled
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/mcp').send({});
      expect(res.status).not.toBe(429);
    }
  });
});
