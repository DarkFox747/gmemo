# Spec — Auth Two-Gate (Cognito JWT + RBAC, read path)

schema: spec-v1
change: auth-two-gate
status: draft

## Overview

Replace the scaffold's fail-open placeholder auth with the real two-gate model for the
interactive human read path: Cognito JWKS token validation (Gate 1), RDS-backed
provisioned-user check + read RBAC (Gate 2), tenant resolution, and audit logging. Lands
the auth/tenancy RDS tables and a DB layer both this change and change B build on. The
service-agent (machine_credential) path is created in schema but enforced fail-closed
(deny) and deferred.

## Requirements

### DB layer & migrations
- **REQ-01** A single pg connection `Pool` MUST be created once at boot and injected; no
  per-request pool/connection construction.
- **REQ-02** `DATABASE_URL` MUST be added to the env schema and validated fail-fast at boot.
- **REQ-03** A forward-only migration mechanism MUST install the auth/tenancy tables and
  their enums/indexes/constraints, faithful to schema v2: `app_user`, `project`, `repo`,
  `project_membership`, `machine_credential`, `access_log`. No memory/staging tables here.
- **REQ-04** Migrations MUST be idempotent to re-run (guard/tracking) and MUST NOT drop data.

### Gate 1 — Cognito JWT (stateless)
- **REQ-05** Every `POST /mcp` tool call MUST validate the bearer access token via Cognito
  JWKS: signature, `iss`, `token_use=access`, `exp`, and `client_id ∈` configured allowlist,
  and required `scope`. The token `aud` claim MUST NOT be validated.
- **REQ-06** Cognito config (`COGNITO_ISSUER`/user pool, `COGNITO_CLIENT_ID` allowlist,
  required scope, JWKS source) MUST come from validated env; missing config fails fast at boot.
- **REQ-07** A missing, malformed, expired, wrong-`client_id`, or wrong-`token_use` token
  MUST be denied with a generic opaque error (no reason enumeration).
- **REQ-08** JWKS keys MUST be cached in-process with automatic refresh on unknown `kid`
  (key rotation) — no per-request JWKS fetch.

### Tenant resolution
- **REQ-09** The server MUST resolve tenant from a client-supplied git remote via
  `X-Git-Remote` (and optional `X-Git-Branch`) header → `repo.remote_url` (UNIQUE) →
  `repo.project_id`. The client MUST NOT pass project/tenant IDs directly.
- **REQ-10** A remote not found in `repo`, or a missing `X-Git-Remote`, MUST yield a generic
  opaque denial (no enumeration of projects/repos).

### Gate 2 + RBAC (read)
- **REQ-11** The JWT `sub` MUST map to an `app_user` row (`idp_subject`) with
  `disabled_at IS NULL`; absence or disabled MUST deny opaquely.
- **REQ-12** Read access to `recall`/`get_memory`/`get_context` MUST require a
  `project_membership` row for (user, resolved project) — viewer+ (any role qualifies for read).
- **REQ-13** Platform global roles do NOT bypass the `project_membership` requirement for reads.
- **REQ-14** The resolved `ActorIdentity` (`actorId` = JWT `sub`; `roles` from RDS) MUST be
  produced during authorization and carried in `RequestContext` — replacing `PLACEHOLDER_ACTOR`.
- **REQ-15** RBAC role precedence MUST prefer the RDS-stored role/global_role over any token claim.

### Audit
- **REQ-16** Every successful read MUST write one `access_log` row with `actor_identity`,
  `actor_kind = user`, `action = read`, `project_id`, and a `query_hash`.
- **REQ-17** `query_hash` MUST be computed server-side from the query; the raw query text
  MUST NEVER be logged, and the client MUST NOT supply the hash.

### Service-agent path (deferred, fail-closed)
- **REQ-18** The `machine_credential` table MUST be created, but service-agent
  authentication MUST be denied (fail-closed) in this change — never fail-open.
- **REQ-19** Any future `machine_credential.token_hash` comparison MUST be constant-time
  (documented now; enforced when implemented).

### Wiring & opacity
- **REQ-20** Real `TenantResolver`, `Authorizer`, `AuditLogger`, and the Gate-1 authenticator
  MUST be singletons injected at boot via transport; placeholders removed.
- **REQ-21** Tool handler signatures `(input, ctx, deps)` MUST NOT change shape; auth plugs
  into the seam layer only.
- **REQ-22** All denials MUST route through the existing `AppError`/`toToolErrorResult`
  opacity path — no stack, tenant, resource, or DB detail reaches the client.

### Testing
- **REQ-23** Tests MUST cover: Gate 1 valid / invalid-signature / expired / wrong-client_id /
  missing-scope; tenant-not-found / missing header; user absent / disabled; no membership;
  happy-path read WITH an `access_log` row asserted; opacity of every denial; machine path denied.
- **REQ-24** The suite MUST run green in CI without a live Cognito or AWS RDS (use a local/
  ephemeral Postgres or a repository fake — per design decision) and existing tests stay green.

## Acceptance Criteria

- With a valid dev token + `X-Git-Remote` for a project the user is a member of, `recall`/
  `get_memory`/`get_context` succeed and an `access_log` row is written (query_hash, not raw).
- Any of: bad/expired/wrong-client token, unknown remote, absent/disabled user, or
  no-membership → generic "Access denied."-class response, no enumeration, no detail leak.
- Service-agent tokens are denied (fail-closed).
- `npm run build && npm test && npm run lint` green; no per-request pool/JWKS construction.
- Placeholders (`PlaceholderAuthorizer`/`PlaceholderTenantResolver`/`PlaceholderAuditLogger`,
  `PLACEHOLDER_ACTOR`) no longer exist in the request path.

## Out of Scope (traceability)
Service-agent auth logic · write tools + their RBAC · staging/promotion · `/promote`
(API Gateway IAM/OIDC) · shared-RBAC-lib extraction · memory/staging tables (change B) ·
Cognito pool + Lambda domain trigger (infra) · the client hook that sets `X-Git-Remote`.
