# HTTP Security Specification

## Purpose

Baseline HTTP hardening for the facade: security headers, per-IP rate limiting on `/mcp` and `/promote` that is correct behind a single ALB, and a production guard that forbids disabling it.

## Requirements

### Requirement: Security headers

`helmet` MUST be applied globally and early, and `X-Powered-By` MUST be disabled. `contentSecurityPolicy` is `false` (JSON API, no browser surface) while HSTS, nosniff and frame-deny stay on. It MUST NOT interfere with the MCP StreamableHTTP transport.

Source: security-hardening

#### Scenario: Headers present

- GIVEN a running app
- WHEN any response is returned
- THEN helmet headers are present and `X-Powered-By` is absent

### Requirement: Rate limiting

`express-rate-limit` MUST limit `POST /mcp` and `POST /promote`, keyed on the real client IP. Defaults, overridable by config: `/mcp` 120 requests/min and `/promote` 10 requests/min. Over-limit MUST return an opaque `429` (`{ error: 'Too Many Requests' }`) with standard `RateLimit-*` headers and no tenant or resource enumeration.

Source: security-hardening

#### Scenario: Limit exceeded

- GIVEN a client exceeding the window
- WHEN it sends another request
- THEN it receives 429 with `RateLimit-*` headers

#### Scenario: Per-client buckets

- GIVEN requests with distinct `X-Forwarded-For` values
- WHEN counting
- THEN each client has its own bucket

### Requirement: Client IP behind the ALB

`trust proxy` MUST be `1` (single ALB hop) so the limiter keys on the right-most `X-Forwarded-For` entry, not a client-forged value and not the ALB IP, and MUST satisfy `express-rate-limit` v7's `validate.trustProxy` (which rejects `true`).

Source: security-hardening

#### Scenario: Forged header

- GIVEN a client sending a forged leading `X-Forwarded-For` entry
- WHEN the limiter keys the request
- THEN the ALB-observed entry is used

### Requirement: Limiter ordering

Per-route limiters MUST run before the JWKS/DB auth work so unauthenticated floods are shed early, and MUST NOT alter any authentication or authorization result for allowed requests.

Source: security-hardening

#### Scenario: Unauthenticated flood

- GIVEN an unauthenticated flood
- WHEN the limit is hit
- THEN requests are rejected before auth work runs

### Requirement: Rate-limit config and production guard

`RATE_LIMIT_ENABLED` (`z.enum(['true','false']).transform`) and four `RATE_LIMIT_{MCP,PROMOTE}_{WINDOW_MS,MAX}` fields (`z.coerce.number().int().min(1).default`) MUST follow existing conventions. `RATE_LIMIT_ENABLED=false` MUST be forbidden in production via `superRefine`, mirroring the stub and bypass guards.

Source: security-hardening

#### Scenario: Disabled in production

- GIVEN `NODE_ENV=production` and `RATE_LIMIT_ENABLED=false`
- WHEN configuration is loaded
- THEN loading fails with an explicit error and the process exits non-zero

### Requirement: Test-friendly plumbing

`createApp(services, options?)` MUST take an options bag that defaults rate limiting to disabled so existing tests stay deterministic, and `src/index.ts` MUST build the options from config so rate limiting is ON in the real app.

Source: security-hardening

#### Scenario: Default in tests

- GIVEN `createApp` called without options
- WHEN requests exceed the production limits
- THEN no 429 is returned

### Requirement: Deployed pilot consistency

The `terraform/modules/service` task definition MUST set `RATE_LIMIT_ENABLED=true`, since the app runs with `NODE_ENV=production` where `false` is forbidden. Window and max MAY stay at defaults.

Source: security-hardening

#### Scenario: Pilot boots

- GIVEN the task definition env
- WHEN the pilot task starts
- THEN the production guard passes

## History

None.
