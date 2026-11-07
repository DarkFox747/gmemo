/**
 * Express application factory.
 *
 * Wires:
 *  - GET  /health  → healthHandler (unauthenticated liveness probe)
 *  - POST /mcp     → stateless Streamable HTTP transport (per-request McpServer)
 *  - GET  /mcp     → 405 (no server-initiated SSE in stateless mode)
 *  - DELETE /mcp   → 405
 *  - POST /promote → promotion endpoint (OIDC-gated; machine_credential path)
 *  - 4-arg error handler (registered last) → opaque 500 with server-side logging
 *
 * Security middleware applied globally (early):
 *  - helmet({ contentSecurityPolicy: false }) — standard HTTP security headers;
 *    CSP is disabled (API-only service, no HTML responses).
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

export interface RateLimitOptions {
  enabled: boolean;
  mcpWindowMs: number;
  mcpMax: number;
  promoteWindowMs: number;
  promoteMax: number;
}

export interface CreateAppOptions {
  rateLimit?: Partial<RateLimitOptions>;
}

const RATE_LIMIT_DEFAULTS: RateLimitOptions = {
  enabled: false,
  mcpWindowMs: 60000,
  mcpMax: 120,
  promoteWindowMs: 60000,
  promoteMax: 10,
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
