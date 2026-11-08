/**
 * Express application factory.
 *
 * Wires:
 *  - GET  /health  → healthHandler (unauthenticated liveness probe)
 *  - POST /mcp     → stateless Streamable HTTP transport (per-request McpServer)
 *  - GET  /mcp     → 405 (no server-initiated SSE in stateless mode)
 *  - DELETE /mcp   → 405
 *  - POST /promote → promotion endpoint (OIDC-gated; machine_credential path)
 *  - /internal/jobs → platform jobs (C3; only when options.jobs is passed; opaque 404s)
 *  - /api          → REST router (own rate limiter → Gate 1 → routes) + the
 *                    /api error mapper (JSON 401/404/400/500)
 *  - static web    → DEV ONLY, when options.webStaticDir is set (SPA fallback
 *                    never matches /api, /mcp, /promote, /health)
 *  - 4-arg error handler (registered last) → opaque 500 with server-side logging
 *
 * Registration order: helmet → json → /health → /mcp → /promote → /internal/jobs → /api router
 * → /api error mapper → static web → terminal handler.
 *
 * Security middleware applied globally (early):
 *  - helmet({ contentSecurityPolicy: false }) — standard HTTP security headers;
 *    the global CSP stays off (JSON/MCP responses); the dev static web sets its
 *    own strict CSP on HTML responses only (src/http/static.ts).
 *  - x-powered-by header disabled (information leakage).
 *  - trust proxy = 1 — single ALB hop; uses right-most XFF for IP keying by
 *    express-rate-limit (non-spoofable, satisfies v8 validate.trustProxy check).
 *
 * The options bag allows callers (tests) to enable per-route rate limiting.
 * It defaults to DISABLED so all existing tests run deterministically without
 * hitting bucket limits.
 *
 * This factory is called once at boot (src/index.ts) and can also be imported
 * directly in tests via supertest without binding a real port.
 */

import type { ErrorRequestHandler } from 'express';
import express from 'express';
import helmet from 'helmet';
import { logger } from '../observability/logger.js';
import { healthHandler } from './health.js';
import { makeMcpPostHandler, handleMcpDelete, handleMcpGet } from '../mcp/transport.js';
import type { AppServices } from '../mcp/context.js';
import { makePromoteHandler } from './promote.js';
import { makeRateLimiter } from './rateLimit.js';
import { makeApiRouter, noStore } from './api/router.js';
import { apiErrorHandler } from './api/errorHandler.js';
import { mountWebStatic } from './static.js';
import { makeJobsRouter } from '../jobs/jobsRouter.js';
import type { JobsRouterDeps } from '../jobs/jobsRouter.js';

export interface RateLimitOptions {
  enabled: boolean;
  mcpWindowMs: number;
  mcpMax: number;
  promoteWindowMs: number;
  promoteMax: number;
  apiWindowMs: number;
  apiMax: number;
}

export interface CreateAppOptions {
  rateLimit?: Partial<RateLimitOptions>;
  /** DEV ONLY: forward X-Dev-User on /api (default false; ignored under production). */
  devUserHeader?: boolean;
  /** DEV ONLY: serve the web build from this directory (index.ts never passes it in production). */
  webStaticDir?: string;
  /** Internal jobs router (/internal/jobs). Absent → the path is not mounted. */
  jobs?: JobsRouterDeps;
}

const RATE_LIMIT_DEFAULTS: RateLimitOptions = {
  enabled: false,
  mcpWindowMs: 60000,
  mcpMax: 120,
  promoteWindowMs: 60000,
  promoteMax: 10,
  apiWindowMs: 60000,
  apiMax: 120,
};

export function createApp(services: AppServices, options?: CreateAppOptions): express.Express {
  const app = express();

  // --- Security: trust proxy (single ALB hop — right-most XFF, non-spoofable) ---
  app.set('trust proxy', 1);

  // --- Security: helmet headers (CSP disabled — API-only service) ---
  app.use(helmet({ contentSecurityPolicy: false }));

  // --- Security: remove Express fingerprinting header (defense-in-depth alongside helmet's hidePoweredBy) ---
  app.disable('x-powered-by');

  // Parse JSON request bodies so req.body is available for the MCP transport.
  // 64 kb limit guards against oversized payloads without affecting normal MCP use.
  app.use(express.json({ limit: '64kb' }));

  // --- Health (unauthenticated, no rate limit) ---
  app.get('/health', healthHandler);

  // --- Resolve rate-limit config (defaults to disabled for test determinism) ---
  const rl: RateLimitOptions = { ...RATE_LIMIT_DEFAULTS, ...options?.rateLimit };

  // --- MCP stateless Streamable HTTP ---
  if (rl.enabled) {
    const mcpLimiter = makeRateLimiter({ windowMs: rl.mcpWindowMs, max: rl.mcpMax });
    app.post('/mcp', mcpLimiter, makeMcpPostHandler(services));
  } else {
    app.post('/mcp', makeMcpPostHandler(services));
  }
  app.get('/mcp', handleMcpGet);
  app.delete('/mcp', handleMcpDelete);

  // --- Promotion endpoint (OIDC-gated; machine_credential path) ---
  if (rl.enabled) {
    const promoteLimiter = makeRateLimiter({ windowMs: rl.promoteWindowMs, max: rl.promoteMax });
    app.post('/promote', promoteLimiter, makePromoteHandler(services));
  } else {
    app.post('/promote', makePromoteHandler(services));
  }

  // --- Internal jobs: own catch-all, so nothing under it reaches static/SPA handling ---
  if (options?.jobs) {
    app.use('/internal/jobs', makeJobsRouter(options.jobs));
  }

  // --- REST API (/api): limiter first so unauthenticated floods are limited too ---
  // noStore first so the limiter's 429 is also uncacheable.
  app.use('/api', noStore);
  const apiRouter = makeApiRouter(services, { devUserHeader: options?.devUserHeader ?? false });
  if (rl.enabled) {
    const apiLimiter = makeRateLimiter({ windowMs: rl.apiWindowMs, max: rl.apiMax });
    app.use('/api', apiLimiter, apiRouter);
  } else {
    app.use('/api', apiRouter);
  }
  // App-level (not inside the router) so express.json parse errors on /api are mapped too.
  app.use('/api', apiErrorHandler);

  // --- DEV ONLY: static web build + SPA fallback ---
  if (options?.webStaticDir) {
    mountWebStatic(app, options.webStaticDir);
  }

  // --- Terminal error handler (must be registered LAST, 4-arg signature) ---
  // Logs the real error server-side; returns a fixed generic body to the client.
  // NEVER sends err.stack, err.message, err.cause, tenant, or resource detail.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error('Unhandled request error', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  };
  app.use(errorHandler);

  return app;
}
