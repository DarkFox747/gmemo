# Design: Security Hardening (helmet + rate limiting)

## FLAGS — confirm before apply

1. **`trust proxy` = numeric `1` (RESOLVE #1).** This is the correct and
   least-spoofable value for the pilot's topology (exactly one ALB hop in front of
   the Fargate task). It is NOT `true` (spoofable) and NOT a CIDR (brittle — ALB
   private IPs are dynamic). See Decision "trust proxy value" for the full contrast
   and the `express-rate-limit` v7 `validate.trustProxy` interaction. **Confirm the
   pilot has exactly one proxy hop (ALB) and no CloudFront/NAT in the request path** —
   the map confirms "no CloudFront/wildcard" and the ALB terminates TLS directly, so
   `1` is right. If a second hop is ever added (e.g. CloudFront), this MUST bump to `2`.

2. **helmet does NOT interfere with the MCP transport (RESOLVE, no streaming risk).**
   The transport is **stateless Streamable HTTP**: `POST /mcp` returns a single
   response and `GET /mcp` (the only server-initiated SSE path) already returns `405`
   (`src/mcp/transport.ts`). helmet only sets response headers — it never touches the
   body or the stream — so there is no header that can interfere with a streaming
   response *in the current stateless mode*. **Flag for the future:** if stateful SSE
   is ever enabled (`GET /mcp` upgraded), re-review `Cross-Origin-Resource-Policy` and
   any caching headers then. No action needed now.

3. **In-memory store is intentional (RESOLVE #3).** `express-rate-limit`'s default
   memory store is correct for the single-task pilot. Horizontal scaling (>1 Fargate
   task) later needs a shared store (Redis/`rate-limit-redis`) — backlog, NOT now.

4. **Human out-of-band prerequisite:** `pnpm add express-rate-limit helmet` must be run
   by a human and `pnpm-lock.yaml` committed BEFORE apply (identical to the
   `@aws-sdk/client-bedrock-runtime` flow). Agents only `pnpm install --frozen-lockfile`.

## Technical Approach

Add two standard Express middlewares to the app factory (`src/http/app.ts`) with zero
change to any auth or promotion outcome:

- `helmet()` + `app.disable('x-powered-by')` mounted globally, early (L-01).
- `express-rate-limit` limiters mounted **per-route, before the route handlers** for
  `POST /mcp` and `POST /promote` (M-02), so an unauthenticated flood is shed with a
  cheap in-memory counter check BEFORE the expensive per-request auth work (Cognito
  JWKS verify + RDS user/membership lookup for `/mcp`; GitHub OIDC JWKS verify + repo/
  machine-credential lookup for `/promote`). Auth today runs *inside* the handlers, so
  "before the handler" is genuinely "before auth" — and a request that passes the
  limiter reaches auth completely unchanged.
- `app.set('trust proxy', 1)` so `req.ip` (and thus the limiter key) resolves to the
  REAL client IP the ALB places in `X-Forwarded-For`, not the ALB's private IP.

All limits come from config (zod, fail-fast, prod-guarded — same conventions as the
existing `*_STUB` / `*_BYPASS` flags). Rate limiting is **opt-in via an explicit
options bag passed to `createApp`**, defaulting to DISABLED when the bag is omitted, so
every existing test (which calls `createApp(services)`) is untouched and deterministic;
`src/index.ts` builds the enabled options from config for the real boot path.

## Architecture Decisions

### Decision: `trust proxy` value — numeric `1`

**Choice**: `app.set('trust proxy', 1)`.

**Alternatives considered**:
- `true` — trust ALL proxies. Express then takes the **left-most** `X-Forwarded-For`
  entry as the client IP. A caller who sends `X-Forwarded-For: 1.2.3.4` gets that value
  trusted verbatim → the rate-limit key is fully **spoofable**, so an attacker can
  rotate the header to get a fresh bucket per request and defeat the limiter entirely.
  `express-rate-limit` v7's `validate.trustProxy` check specifically **errors/warns**
  when it detects `trust proxy === true` for exactly this reason.
- A CIDR / subnet (e.g. the ALB subnet) — correct in principle (trust addresses in that
  range) but **brittle**: ALB node private IPs are dynamic and the tasks may share the
  subnet, so the trusted range is hard to pin and drifts with infra changes. More config
  to maintain for no security gain over a hop count here.
- A numeric hop count `1` (**chosen**) — trust exactly the 1 proxy closest to the app.
  The socket peer is the ALB (untrusted as an *identity*, trusted as *one hop*), and
  Express resolves `req.ip` to the **right-most** `X-Forwarded-For` entry, which is the
  IP the ALB itself observed and appended. Because the ALB *appends* the true client
  socket address, a client that pre-seeds `X-Forwarded-For: 1.2.3.4` produces
  `X-Forwarded-For: 1.2.3.4, <realClientIP>` and Express (hop count 1) picks
  `<realClientIP>` — the spoofed prefix is ignored. Least-spoofable correct option.

**Rationale**: The pilot topology is deterministic and simple — exactly one ALB hop, no
CloudFront, no NAT in the request path (project-map `infra.pilot_topology`). A hop count
matches that exactly, is spoof-resistant, needs no IP list to maintain, and satisfies
`express-rate-limit`'s own trust-proxy validation. If a second hop is ever introduced,
this is a one-line bump to `2` (documented in FLAG #1).

### Decision: rate-limit key — client IP for BOTH endpoints

**Choice**: `keyGenerator` defaults to `req.ip` (client IP resolved via `trust proxy`)
for both `/mcp` and `/promote`. Do NOT key by authenticated identity.

**Alternatives considered**:
- Key `/mcp` by Cognito `sub` / key `/promote` by repo principal — rejected because the
  limiter runs **before** auth by design (to shed floods before the expensive JWKS/DB
  work). The identity is not resolved yet at limiter time, so it is not available as a
  key. Keying by identity would force auth to run first, defeating the whole point (an
  unauthenticated flood would pay the full JWKS/DB cost per request).

**Rationale**: IP keying is the only key available before auth, is consistent across
both endpoints, and is exactly the interim control M-02 asks for (WAF/per-identity
quotas are explicitly OUT). With `trust proxy = 1` the IP is the real, non-spoofable
client address, so per-IP buckets are meaningful.

### Decision: default windows + max per endpoint

**Choice** (pilot scale — single task, low concurrency; all overridable via env):

| Endpoint | window | max | Rationale |
|----------|--------|-----|-----------|
| `POST /mcp` | 60_000 ms (1 min) | 120 | Agents are chatty (recall/remember/get_context), ~2 req/s sustained per client IP is generous for the pilot yet caps a runaway loop or flood. |
| `POST /promote` | 60_000 ms (1 min) | 10 | Promotion is rare — fires only on PR-merge-to-default-branch. 10/min per IP is far above legitimate use and still sheds a burst. |

**Alternatives considered**: tighter `/mcp` (e.g. 60/min) — rejected as too easy to
trip for a legitimately active agent session during the pilot; looser — rejected as
weak flood protection. Values are config-driven so ops can retune without a deploy.

### Decision: opaque 429 body + standard headers

**Choice**: `message: { error: 'Too Many Requests' }`, `standardHeaders: true`
(draft `RateLimit-*` headers), `legacyHeaders: false`. Return code 429.

**Rationale**: Matches the existing opacity model (`{ error: 'Method Not Allowed' }`,
`{ error: 'Internal server error' }`) — no tenant/resource enumeration. The standard
`RateLimit-*` headers advertise the policy, not any tenant data, so they are safe and
help well-behaved clients back off.

### Decision: helmet config — defaults minus CSP

**Choice**: `helmet({ contentSecurityPolicy: false })`.

**Alternatives considered**:
- Full defaults (CSP on) — rejected: CSP governs browser resource loading; this is a
  JSON API with **no HTML/browser surface**, so a CSP is meaningless overhead and a
  future maintenance trap (any HTML tooling would trip a policy that protects nothing).
- A hand-rolled minimal CSP — rejected as YAGNI (no browser surface to protect).

**Rationale**: Keep helmet's genuinely useful API-relevant headers at their defaults —
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Strict-Transport-Security` (valuable: ALB terminates TLS on :443 and redirects :80),
`X-DNS-Prefetch-Control`, `Referrer-Policy`, etc. Only disable the browser-content
policy that has no target here. Lean, per the proposal.

### Decision: plumb config via a `createApp` options bag (default DISABLED)

**Choice**: `createApp(services, options?)` where `options` is an optional
`HttpOptions` bag `{ rateLimit: { enabled, mcp: {windowMs, max}, promote: {windowMs, max} }, trustProxy }`.
Omitted → rate limiting disabled and `trust proxy` unset. `src/index.ts` builds the bag
from `config`.

**Alternatives considered**:
- Add rate-limit scalars onto `AppServices` (as `semanticFallbackK` etc. already are) —
  rejected: `AppServices` is the MCP dependency-injection bag; HTTP-transport concerns
  (trust proxy, limiter windows) do not belong there and would leak into every MCP
  handler's type surface.
- Read `config` directly inside `app.ts` — rejected: the factory is currently
  config-free and unit-testable in isolation; injecting an explicit options bag keeps
  that property and lets tests set tiny limits deterministically.

**Rationale**: A second, optional param is the smallest change that (a) keeps every
existing `createApp(services)` caller/test untouched and deterministic (limiter off by
default), (b) keeps the factory pure/testable, and (c) lets the new tests dial `max`
down to trigger 429 in 2-3 requests. `RATE_LIMIT_ENABLED=false` is also prod-guarded so
the disable path can never ship to production.

## Data Flow

    Client ──HTTPS──▶ ALB (sets X-Forwarded-For: <clientIP>)
                        │  (terminates TLS, one hop)
                        ▼
      Fargate task: Express app  [trust proxy = 1 → req.ip = real client IP]
        app.disable('x-powered-by')
        helmet()                         ← global, early (all routes)
        express.json({limit:'64kb'})     ← global
          │
          ├─ GET  /health                         → healthHandler   (no limiter)
          │
          ├─ POST /mcp   ─▶ mcpLimiter ─▶ makeMcpPostHandler
          │                    │ (over? 429)          │
          │                    │                       └─▶ auth (Cognito JWKS + RDS)  ← expensive; only if under limit
          │                    ▼
          │                 429 opaque
          │
          └─ POST /promote ─▶ promoteLimiter ─▶ makePromoteHandler
                                 │ (over? 429)            │
                                 │                         └─▶ OIDC verify + repo/cred lookup  ← expensive; only if under limit
                                 ▼
                              429 opaque

Key point: the limiter's cheap in-memory counter check runs BEFORE the JWKS/DB auth
work, so floods are shed early — but a request that passes the limiter enters the
existing handler byte-for-byte unchanged (auth outcome never altered).

## Config additions (`src/config/index.ts`)

Add these fields to `envSchema` (same conventions as existing entries):

```ts
// Rate limiting (M-02) — in-memory per-task limiter on POST /mcp and POST /promote.
// Safe boolean via z.enum (NOT z.coerce.boolean). Disable ONLY for tests; prod-guarded below.
RATE_LIMIT_ENABLED: z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true'),
// Windows + max are parsed like PORT/BEDROCK_*: coerce string env → int, enforce ≥ 1.
RATE_LIMIT_MCP_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
RATE_LIMIT_MCP_MAX: z.coerce.number().int().min(1).default(120),
RATE_LIMIT_PROMOTE_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
RATE_LIMIT_PROMOTE_MAX: z.coerce.number().int().min(1).default(10),
```

Add one prod guard inside the existing `.superRefine(...)`, mirroring the
`AUTH_DEV_BYPASS` / `JUDGE_STUB` guards:

```ts
// ── LOAD-BEARING PROD GUARD — rate limiting ──────────────────────────────
// Rate limiting MUST NOT be disabled in production (defense-in-depth, M-02).
if (!cfg.RATE_LIMIT_ENABLED && cfg.NODE_ENV === 'production') {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['RATE_LIMIT_ENABLED'],
    message: 'RATE_LIMIT_ENABLED=false is forbidden when NODE_ENV=production.',
  });
}
```

Note: `trust proxy` is a fixed `1` (FLAG #1), not an env var — it is a topology
constant for the pilot, so it lives in code with a comment, not config. (If ops ever
need to tune it, promote it to `TRUST_PROXY_HOPS: z.coerce.number().int().min(0)` then —
YAGNI now.)

## Test strategy (`tests/http/`, vitest + supertest, NO real network)

New file `tests/http/security.test.ts`. Build the app with `createApp(makeStubAuthServices(...), options)`
(reuse `tests/auth/fakes.ts`), passing tiny limits so 429 triggers in a few requests.

- **helmet headers present / `X-Powered-By` absent** — one GET `/health` (unauthenticated,
  no limiter); assert `x-content-type-options: nosniff`, `strict-transport-security`
  present and `x-powered-by` undefined. Confirms L-01 without touching auth.
- **429 after N within window** — build app with `rateLimit.mcp.max = 2`; fire 3 POSTs
  to `/mcp` from the same simulated IP; assert first 2 are non-429 and the 3rd is
  `429 { error: 'Too Many Requests' }` (opaque). Same shape for `/promote` with
  `promote.max = 2`.
- **per-IP keying** — with `trust proxy` enabled in the test app, send N+1 requests with
  `.set('X-Forwarded-For', '203.0.113.1')` (all 429 after the cap) and then a request
  with `.set('X-Forwarded-For', '203.0.113.2')` and assert it is NOT limited — proving
  buckets are keyed on the real client IP from XFF, not shared.
- **disabled path** — build app with `rateLimit.enabled = false` (or omit the options
  bag) and assert many rapid requests never 429 — proving the test-disable switch and
  that existing suites (which omit the bag) stay fast/deterministic.

No timers/real windows are relied on for the 429 test (we exhaust `max` within the
window synchronously), so the suite is fast and deterministic. No live AWS/DB — auth
services are the existing in-memory fakes.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` / `pnpm-lock.yaml` | Modify (HUMAN, out-of-band) | `pnpm add express-rate-limit helmet`; commit lockfile BEFORE apply. |
| `src/http/rateLimit.ts` | Create | `HttpOptions` type + `makeMcpLimiter(opts)` / `makePromoteLimiter(opts)` factories (opaque 429, standard headers, IP key, in-memory store). Keeps `app.ts` lean. |
| `src/http/app.ts` | Modify | Add `options?: HttpOptions` param; `app.disable('x-powered-by')`; `app.set('trust proxy', options.trustProxy ?? false)`; `app.use(helmet({ contentSecurityPolicy: false }))` early; mount `mcpLimiter` before `POST /mcp` and `promoteLimiter` before `POST /promote` only when `rateLimit.enabled`. No change to handlers or the terminal error handler. |
| `src/config/index.ts` | Modify | Add `RATE_LIMIT_ENABLED` + 4 window/max fields (defaults above) + the prod guard in `superRefine`. |
| `src/index.ts` | Modify | Build the `HttpOptions` bag from `config` (`trustProxy: 1`, enabled + windows/max) and pass it as the 2nd arg to `createApp(services, options)`. |
| `tests/http/security.test.ts` | Create | supertest suite: helmet headers + no `X-Powered-By`; 429-after-N for `/mcp` and `/promote`; per-IP keying via `X-Forwarded-For`; disabled path. |

## Task ordering (tasks-friendly)

1. **(HUMAN prereq)** `pnpm add express-rate-limit helmet`, commit `pnpm-lock.yaml`.
2. Config: add fields + prod guard (`src/config/index.ts`).
3. Create `src/http/rateLimit.ts` (limiter factories + `HttpOptions` type).
4. Wire `src/http/app.ts` (disable x-powered-by, trust proxy, helmet, per-route limiters via options).
5. Build the options bag in `src/index.ts`.
6. Add `tests/http/security.test.ts`.

## Verify gate

`pnpm build && pnpm test -- --run && pnpm lint` (all green; new tests included; existing
suites unchanged because rate limiting defaults to disabled when the options bag is omitted).
</content>
</invoke>
