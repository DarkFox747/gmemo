# Archive Report — security-hardening

## Outcome: DONE (verify PASS after remediation)

Defense-in-depth for the pilot before live traffic: `helmet` + `express-rate-limit`,
with a spoof-resistant rate-limit key.

## Delivered
- `src/http/rateLimit.ts` (new) — IP-keyed limiter factory; explicit `keyGenerator`
  reading the RIGHT-MOST `X-Forwarded-For` entry (ALB-appended real client IP,
  unforgeable for single-ALB); `standardHeaders:'draft-7'`, opaque 429
  `{ error: 'Too Many Requests' }`; explicit `RequestHandler` return type.
- `src/http/app.ts` — `helmet({ contentSecurityPolicy: false })` + `x-powered-by` off
  (defense-in-depth) + `trust proxy = 1`; `createApp(services, options?)` (rate-limiting
  OFF by default for tests); `/mcp` + `/promote` limiters before auth.
- `src/config/index.ts` — `RATE_LIMIT_ENABLED` (default `'true'`) + 4 window/max fields
  (mcp 120/min, promote 10/min); superRefine forbids `false` in production.
- `src/index.ts` — threads config into createApp.
- `terraform/modules/service/main.tf` — `RATE_LIMIT_ENABLED=true` in the task-def.
- `tests/http/security.test.ts` — 429 + opaque body, RateLimit-* + HSTS headers,
  x-powered-by absent, per-IP isolation, right-most-XFF regression (H1). **462 tests.**

## Verify
FAIL → remediated (1 HIGH rate-limit-key spoofability + 4 LOW) → PASS. The HIGH was a
contested trust-proxy subtlety; resolved FAIL-SAFE with an explicit right-most-XFF key
and a regression test that verifies the behavior at the source.

## Deferred (backlog)
- WAF rate rule for unauthenticated endpoints (`/health`, `GET/DELETE /mcp` 405) at GA.
- Shared/Redis-backed limiter store when scaling beyond the single Fargate task
  (in-memory buckets are per-task).
