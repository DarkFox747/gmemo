# Spec — security-hardening

`design.md` is authoritative for exact placement/config. Outcome requirements:

### REQ-01 — Security headers (L-01)
`helmet` is applied globally (early) and `X-Powered-By` is disabled. Config:
`contentSecurityPolicy: false` (JSON API, no browser surface); HSTS / nosniff /
frame-deny kept. MUST NOT interfere with the MCP StreamableHTTP transport.

### REQ-02 — Rate limiting (M-02)
`express-rate-limit` limits `POST /mcp` and `POST /promote`, keyed on the real client
IP. Defaults (config-overridable): `/mcp` 120 req/min, `/promote` 10 req/min. Over-limit
→ opaque `429` (`{ error: 'Too Many Requests' }`) + standard `RateLimit-*` headers. No
tenant/resource enumeration.

### REQ-03 — Correct client IP behind ALB
`trust proxy = 1` (single ALB hop) so the limiter keys on the ALB-observed
(right-most) `X-Forwarded-For` entry, NOT a client-forged value and NOT the ALB IP.
MUST satisfy `express-rate-limit` v7's `validate.trustProxy` (which rejects `true`).

### REQ-04 — Limiter runs before auth, without changing auth outcomes
Per-route limiters are positioned BEFORE the JWKS/DB auth work so unauthenticated
floods are shed early. They MUST NOT alter any authentication/authorization result for
allowed requests.

### REQ-05 — Config + prod guard
Add `RATE_LIMIT_ENABLED` (`z.enum(['true','false']).transform`) + four
`RATE_LIMIT_{MCP,PROMOTE}_{WINDOW_MS,MAX}` (`z.coerce.number().int().min(1).default`)
fields, following existing conventions. superRefine: `RATE_LIMIT_ENABLED=false` is
FORBIDDEN in production (mirror the `*_STUB`/`*_BYPASS` guards).

### REQ-06 — Test-friendly plumbing
`createApp(services, options?)` gains an options bag that defaults rate-limiting
DISABLED, so existing tests stay deterministic and untouched. `src/index.ts` builds
options from config (rate-limiting ON in the real app).

### REQ-07 — Deployed pilot consistency
`terraform/modules/service` task-def env MUST set `RATE_LIMIT_ENABLED=true` (the app
runs `NODE_ENV=production`, where the guard forbids `false`), keeping the deployed
pilot bootable. Window/max may stay at defaults.

## Acceptance Criteria
- 429 after exceeding the window; helmet headers present; `X-Powered-By` absent;
  limiter keys per client IP (distinct `X-Forwarded-For` → distinct buckets).
- All existing tests still pass (rate-limiting off by default in `createApp`).
- `pnpm build && pnpm test -- --run && pnpm lint` green. Deps `express-rate-limit` +
  `helmet` present (added out-of-band). Terraform still `fmt`/`validate` clean.
- No auth weakening; opaque 429; no secrets.
