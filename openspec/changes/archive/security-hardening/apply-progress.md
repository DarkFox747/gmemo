# Apply Progress — security-hardening

## Batch 1 — SUCCESS (single worker, T001–T008)

Defense-in-depth added before live traffic: `helmet` + `express-rate-limit`.

Files:
- `src/config/index.ts` — `RATE_LIMIT_ENABLED` (safe bool) + 4 window/max fields
  (defaults 60000/120 mcp, 60000/10 promote); superRefine forbids `false` in production
- `src/http/rateLimit.ts` (new) — IP-keyed limiter factory, `standardHeaders:'draft-7'`,
  opaque 429 `{ error: 'Too Many Requests' }`
- `src/http/app.ts` — `helmet({contentSecurityPolicy:false})` + `x-powered-by` off +
  `trust proxy = 1`; `createApp(services, options?)` (rate-limiting OFF by default for
  tests); `/mcp` + `/promote` limiters mounted before auth when enabled
- `src/index.ts` — threads the 5 rate-limit config values into createApp
- `terraform/modules/service/main.tf` — `RATE_LIMIT_ENABLED=true` in the task-def env
  (prod-guard consistency)
- `tests/http/security.test.ts` (new, 8 tests) — 429 + opaque body, RateLimit-* headers,
  helmet headers present + X-Powered-By absent, per-IP bucket isolation via XFF, off-by-default

Gate: `pnpm build`+`lint`+`test` → **460 tests / 0 failed**; `terraform fmt -check` +
`validate` clean. T001 (`pnpm add express-rate-limit helmet`) done by human.

Deviations: none. Issues: none.
