# Proposal — security-hardening

## Why
Before the pilot takes live traffic, two defense-in-depth gaps flagged across prior
verifies remain open:
- **M-02** — no app-level rate limiting on `POST /mcp` or `POST /promote`. A valid
  token holder (or a burst of unauthenticated attempts hitting auth) can flood the
  endpoints. WAF is the primary control (deferred), so this is the interim defense.
- **L-01** — no security response headers; Express advertises `X-Powered-By`.

## Chosen approach — minimal, standard middleware
- **`helmet`** on the Express app + `app.disable('x-powered-by')` (L-01). API-only
  service (no HTML), so a lean helmet config (sensible defaults; CSP minimal/omitted
  since there's no browser surface).
- **`express-rate-limit`** (M-02) on `POST /mcp` AND `POST /promote`, with limits from
  config (window + max), returning `429` with an opaque body (no enumeration).
- **`trust proxy`** configured correctly so the limiter keys on the real client IP
  (`X-Forwarded-For` set by the ALB), NOT the ALB's IP — otherwise all clients share
  one bucket. Trust exactly the ALB hop (not a blanket `true`, which is spoofable).

## Scope boundaries
IN: `helmet` + `x-powered-by` off; `express-rate-limit` on `/mcp` + `/promote`;
`trust proxy` config; config fields for windows/limits (+ a test-friendly disable);
unit/integration tests (429 after N; headers present; limiter keys per client IP).
Deps: `express-rate-limit`, `helmet` (added out-of-band via `pnpm add`).

OUT (later): WAF, API Gateway throttling, distributed/Redis-backed rate limiting
(in-memory per-task is fine for the single-task pilot), per-identity quotas.

## OPEN DECISIONS for the architect to resolve/FLAG
1. **`trust proxy` value** — exact setting for a single ALB hop (e.g. `1`) vs the ALB
   subnet CIDR; pick the least-spoofable correct option and FLAG.
2. **Rate-limit key + limits** — key by IP, or by authenticated identity (Cognito
   `sub` / repo principal) where available? Default windows/max per endpoint.
3. **In-memory store caveat** — single Fargate task now, so in-memory is fine; note
   that horizontal scaling later needs a shared store (backlog, not now).

## Affected Areas
| Area | Files | Change |
|------|-------|--------|
| App wiring | `src/http/app.ts` (or `src/index.ts`) | helmet + x-powered-by off + trust proxy + limiters |
| Rate limit | new `src/http/rateLimit.ts` (if cleaner) | configured limiters for /mcp + /promote |
| Config | `src/config/index.ts` | RATE_LIMIT_* windows/max + disable flag |
| Deps | `package.json` / lockfile | `express-rate-limit`, `helmet` |
| Tests | `tests/http/*` | 429 behavior, headers, per-IP keying |

## Constraints
- pnpm-ONLY (deps added out-of-band, then frozen-install).
- Opaque 429 (no tenant/resource enumeration), consistent with existing error policy.
- Do NOT weaken auth or the existing prod guards; limiters run BEFORE auth on the
  route so unauthenticated floods are shed early, but MUST NOT change auth outcomes.
- YAGNI: in-memory limiter, lean helmet; no Redis, no WAF here.
