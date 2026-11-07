/**
 * Rate-limiter factory.
 *
 * Builds an express-rate-limit middleware instance keyed by the right-most
 * X-Forwarded-For entry (the ALB-appended, unforgeable real client IP for the
 * single-ALB topology), using standard headers (RateLimit-*) and opaque 429
 * responses (no tenant or resource detail — consistent with the project's
 * opacity error policy).
 *
 * Trust-proxy is configured at the Express level (trust proxy = 1 for a
 * single ALB hop), satisfying express-rate-limit v8's validate.trustProxy
 * check. The explicit keyGenerator below is the authoritative key — it does
 * not depend on req.ip or proxy-addr indexing semantics.
 *
 * Key: right-most XFF entry (ALB-appended, unforgeable). A client can
 * pre-seed the left side of XFF, but the ALB always APPENDS the real observed
 * IP at the end, so only the right-most entry is trustworthy.
 */

import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

/**
 * Extracts the right-most X-Forwarded-For entry (the ALB-appended real client
 * IP, unforgeable in the single-ALB topology). Falls back to the socket remote
 * address when XFF is absent.
 */
function rightMostXff(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const entries = raw.split(',');
    const rightMost = entries[entries.length - 1].trim();
    if (rightMost) return rightMost;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Returns an express-rate-limit middleware configured for the given window
 * and request ceiling. Each route mounts its own limiter for independent
 * per-route buckets.
 *
 * The rate-limit key is the right-most XFF entry (ALB-appended real client IP).
 */
export function makeRateLimiter(opts: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    // Key: right-most (ALB-appended) XFF entry — unforgeable in single-ALB topology.
    keyGenerator: rightMostXff,
    // Standard RateLimit-* headers (RFC draft); legacy X-RateLimit-* disabled.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Opaque handler — never reveal bucket state, tenant, or resource detail.
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too Many Requests' });
    },
  });
}
