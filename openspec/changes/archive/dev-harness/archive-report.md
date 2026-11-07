# Archive Report — Dev Harness

schema: archive-report-v1
change: dev-harness
status: CLOSED
verdict: PASS
archived_at: 2026-07-30

## Outcome
The MCP server is now locally runnable end-to-end via `docker compose up`: Postgres 16 +
migrations + dev seed + app. Gate 1 (Cognito) is stubbed by a `DevAuthenticator` behind a
4-barrier production guard; Gate 2, RBAC, and audit run for real against the seeded local DB.

## Pipeline
proposal (D1–D5) → specs ∥ design → tasks → apply (3 parallel workers) → verify (security +
reviewer + build-worker) → remediation (1 worker) → archive.

## Requirements
All REQ-01..REQ-19 satisfied. See verify-report.md.

## Security — prod guard (audited, holds)
Bypass impossible in production; seed never applied in production. 4 barriers: config superRefine,
index.ts NODE_ENV selection, seed.ts fail-closed (NODE_ENV===development), migrate numbered-only filter.
`AUTH_DEV_BYPASS` avoids the coerce-boolean footgun. Bypass stubs ONLY Cognito. 0 CRITICAL / 0 HIGH.

## Deferred → backlog
- helmet security headers + express-rate-limit (need new deps).
- Production Docker/ECR/Fargate hardening + CI publish.
- Write path (staging + remember/list_staged/discard_staged + promotion/judge/quarantine).
- pgvector.

## Accepted trade-off
- `seed.dev.sql` ships in the image (local compose seed needs it; no secrets; runtime barriers prevent prod use).

## Human follow-up (once)
Run `docker compose up --build` on a Docker-capable machine to confirm the end-to-end boot +
a sample `POST /mcp` recall/get_context with the seeded `X-Git-Remote` (Docker not executable in the build env).
