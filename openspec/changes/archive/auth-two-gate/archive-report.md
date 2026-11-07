# Archive Report — Auth Two-Gate (Cognito JWT + RBAC, read path)

schema: archive-report-v1
change: auth-two-gate
status: CLOSED
verdict: PASS
archived_at: 2026-07-30

## Outcome
Replaced the scaffold's fail-open placeholder auth with the real two-gate model for the
interactive human read path: Cognito JWKS (Gate 1) + RDS provisioned-user & project_membership
RBAC (Gate 2) → ActorIdentity, tenant resolution via X-Git-Remote, and audit logging with a
server-side query_hash. Landed the auth/tenancy RDS tables + a pnpm-based DB layer (pool +
forward-only migration runner). Service-agent path created in schema, enforced fail-closed.

## Pipeline
explore (2 agents) → proposal (D1–D7) → specs ∥ design → tasks (2 waves) → apply (4 workers, 2 waves)
→ [tooling standardization: pnpm-only] → verify (security + reviewer + build-worker) → remediation
(1 worker) → archive.

## Requirements
All REQ-01..REQ-24 satisfied. See verify-report.md.

## Security
Two-gate correct; global role does not bypass membership; RDS roles preferred over claims; all SQL
parameterized; opacity byte-identical across denials; query_hash server-side; machine path fail-closed;
prod DB TLS enforced. 0 CRITICAL / 0 HIGH after remediation.

## Carry-forwards → backlog (not blocking)
- Service-agent (machine_credential) authentication (currently fail-closed).
- M-02 rate limiting + L-01 helmet/security-headers (need new deps: express-rate-limit, helmet).
- Archived-project filter in tenant/RBAC queries (needs archival semantics).
- UNIQUE(project_id, principal_name) on machine_credential (provisioning path).

## Notes
- Tooling standardized to pnpm-ONLY mid-change (removed bun.lock + package-lock.json; pinned
  packageManager; engine-strict; guard hardened). Guard change activates next session.
- Config var names: COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID_ALLOWLIST / COGNITO_REQUIRED_SCOPE
  (region derived from pool id). Confirm against the future Cognito/infra provisioning change.
