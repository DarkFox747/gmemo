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

### Requirement: API rate limit and static content security

`/api` SHALL have its own rate limiter (`RATE_LIMIT_API_WINDOW_MS`, default 60000; `RATE_LIMIT_API_MAX`, default 120; invalid values fail fast; disabling stays forbidden in production). When the development static web is served, HTML responses SHALL carry a same-origin Content-Security-Policy, while API responses keep the existing security headers and `Cache-Control: no-store`.

Source: web-api-and-review-queue

#### Scenario: API limiter
- GIVEN `RATE_LIMIT_API_MAX=2`
- WHEN a third API request arrives within the window
- THEN it receives 429 with RateLimit headers

## History

None.

### Requirement: Additional credential detectors

Source: ci-and-security-followups

The secret scanner SHALL detect, at capture and in the promotion pipeline, kind-prefixed `sk-` keys (`sk-<2–10 letters>-<20+ token chars>`: OpenAI `sk-proj-`/`sk-svcacct-`/`sk-admin-`/`sk-None-`, Anthropic-style `sk-ant-`, `sk-or-`), GitHub fine-grained PATs (`github_pat_…`) and AWS secret access keys (a 40-character base64 value after an AWS secret key name — `aws_secret`, `aws_secret_key`, `aws_secret_access_key` with `_`, `-` or space separators, `secretAccessKey` — followed by `=`, `:` or whitespace, optionally quoted), and SHALL redact only the matched span with `[REDACTADO]`. An AWS access key id together with a bare 40-character base64 token in the same scanned text SHALL count as an AWS secret access key; in the promotion pipeline such a pair SHALL redact the whole item.

#### Scenario: Fine-grained PAT rejected at capture
- GIVEN a `remember` body containing a `github_pat_` token
- WHEN the agent stages it
- THEN the capture is rejected and nothing is stored

#### Scenario: AWS secret in promotion
- GIVEN a staged item whose fields contain `aws_secret_access_key = <40-char value>`
- WHEN it is promoted
- THEN it goes to quarantine with `leak = true` and only the value span is redacted

#### Scenario: AWS secret written with spaces
- GIVEN text `AWS secret access key <40-char value>`
- WHEN scanned
- THEN an AWS secret access key is reported and only the value span is located

#### Scenario: AWS access key id and bare secret together
- GIVEN a staged item with an AWS access key id in its title and a bare 40-character base64 token in its body
- WHEN it is promoted
- THEN it goes to quarantine with `leak = true` and the whole item is redacted

#### Scenario: Anthropic-style key
- GIVEN text containing an `sk-ant-…` key
- WHEN scanned
- THEN a credential is reported and the whole token is the redaction span

#### Scenario: No false positive
- GIVEN benign text with 40-character hashes not assigned to an AWS secret key and with no AWS access key id
- WHEN scanned
- THEN no credential is reported

### Requirement: Atomic audit for REST writes

Source: ci-and-security-followups

Every REST write (review approve/reject, quarantine restore, memory create/amend/confirm/retire/retire-by-pr) SHALL write its `access_log` row in the same transaction as the data change; if the audit insert fails, the data change SHALL be rolled back and the request fails opaquely.

#### Scenario: Audit failure rolls back
- GIVEN the audit insert fails during a retire
- WHEN the tech lead retires a memory
- THEN the memory stays active and the response is the generic error

### Requirement: Restore un-claim after a failure

Source: ci-and-security-followups

When a quarantine restore fails after its claim (pipeline error, audit failure, or an outcome restore cannot produce), the service SHALL abandon the `restore/<id>` session and clear the row's `restored_*` label in one statement, only while the claimed item has not been written, so the row is listed again and a retry can claim it. No audit row is written.

#### Scenario: Audit failure during restore
- GIVEN the audit insert fails during a restore
- WHEN the tech lead restores a quarantined item
- THEN nothing is applied, the restore session is abandoned, the row is active again, and a retry restores it

### Requirement: CI test gate

Source: ci-and-security-followups

A GitHub Actions workflow SHALL run lint, build, web typecheck/build and the full test suite with a pgvector Postgres service on pull requests and pushes to the default branch, with pinned actions and read-only permissions.

#### Scenario: Pull request checked
- GIVEN a pull request
- WHEN CI runs
- THEN all checks run against a fresh database and the job fails on any failure
