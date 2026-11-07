# Auth Specification

## Purpose

Two-gate access control for the MCP facade: Gate 1 validates the Cognito access token statelessly, Gate 2 checks the provisioned user and project membership in RDS. Tenant is resolved from the git remote, and every successful read is audited. The dev-only Gate 1 bypass is impossible in production.

## Requirements

### Requirement: Database layer and auth migrations

A single `pg` connection `Pool` MUST be created once at boot and injected. `DATABASE_URL` MUST be validated fail-fast at boot. A forward-only, idempotent migration mechanism MUST install `app_user`, `project`, `repo`, `project_membership`, `machine_credential` and `access_log` faithful to schema v2, and MUST NOT drop data.

Source: auth-two-gate

#### Scenario: Re-running migrations

- GIVEN migrations were already applied
- WHEN the migrator runs again
- THEN no data is dropped and no error occurs

### Requirement: Gate 1 Cognito JWT validation

Every `POST /mcp` tool call MUST validate the bearer access token via Cognito JWKS: signature, `iss`, `token_use=access`, `exp`, `client_id` within the configured allowlist, and the required `scope`. The `aud` claim MUST NOT be validated. Cognito config MUST come from validated env and missing config SHALL fail fast at boot. JWKS keys MUST be cached in-process and refreshed on unknown `kid`.

Source: auth-two-gate

#### Scenario: Invalid token

- GIVEN a missing, malformed, expired, wrong-`client_id`, wrong-`token_use`, bad-signature or missing-scope token
- WHEN calling a tool
- THEN the call is denied with a generic opaque error that does not reveal the reason

### Requirement: Tenant resolution from git remote

The server MUST resolve the tenant from `X-Git-Remote` (and optional `X-Git-Branch`) via `repo.remote_url` to `repo.project_id`. The client MUST NOT pass project or tenant IDs. An unknown or missing remote MUST yield a generic opaque denial.

Source: auth-two-gate

#### Scenario: Unknown remote

- GIVEN a valid token and an `X-Git-Remote` not present in `repo`
- WHEN calling a tool
- THEN the response is a generic denial with no project or repo enumeration

### Requirement: Gate 2 user check and read RBAC

The JWT `sub` MUST map to an `app_user` (`idp_subject`) with `disabled_at IS NULL`, otherwise deny opaquely. Read access to `recall`, `get_memory` and `get_context` MUST require a `project_membership` for the user and resolved project (any role). Global platform roles MUST NOT bypass the membership requirement. RDS-stored roles MUST take precedence over token claims. The resolved `ActorIdentity` MUST be carried in `RequestContext`.

Source: auth-two-gate

#### Scenario: Absent, disabled or non-member user

- GIVEN a valid token whose user is absent, disabled, or has no membership in the resolved project
- WHEN calling a read tool
- THEN access is denied with a generic opaque error

### Requirement: Read audit

Every successful read MUST write one `access_log` row with `actor_identity`, `actor_kind=user`, `action=read`, `project_id` and a `query_hash`. The hash MUST be computed server-side, the raw query text MUST NEVER be logged, and the client MUST NOT supply the hash.

Source: auth-two-gate

#### Scenario: Happy-path read

- GIVEN a valid token and `X-Git-Remote` for a project the user belongs to
- WHEN calling `recall`, `get_memory` or `get_context`
- THEN the call succeeds and an `access_log` row with `query_hash` (not raw text) is written

### Requirement: Machine credential comparison

Any `machine_credential.token_hash` comparison MUST be constant-time. The human `/mcp` path MUST deny service-agent tokens (fail-closed); the `/promote` machine path is specified in `promotion`.

Source: auth-two-gate

#### Scenario: Service-agent token on the human path

- GIVEN a service-agent token presented to `/mcp`
- WHEN calling a tool
- THEN access is denied

### Requirement: Seam wiring and opacity

The real `TenantResolver`, `Authorizer`, `AuditLogger` and Gate 1 authenticator MUST be singletons injected at boot. Tool handler signatures `(input, ctx, deps)` MUST NOT change shape. All denials MUST route through the `AppError`/`toToolErrorResult` opacity path.

Source: auth-two-gate

#### Scenario: Denial leaks nothing

- GIVEN any denial
- WHEN the response is produced
- THEN no stack, tenant, resource or DB detail reaches the client

### Requirement: Auth test coverage

Tests MUST cover Gate 1 (valid, invalid signature, expired, wrong client_id, missing scope), tenant not found and missing header, user absent or disabled, no membership, the happy path with an asserted `access_log` row, opacity of every denial, and machine path denied. The suite MUST run without live Cognito or AWS.

Source: auth-two-gate

#### Scenario: CI without AWS

- GIVEN no Cognito or RDS access
- WHEN running `pnpm test`
- THEN the auth tests pass using a local Postgres or a repository fake

### Requirement: Dev auth bypass guard

`AUTH_DEV_BYPASS` (boolean, default `false`) MUST be part of the validated config. The bypass MUST engage ONLY when `NODE_ENV !== 'production'` AND `AUTH_DEV_BYPASS=true`. With `AUTH_DEV_BYPASS=true` and `NODE_ENV=production` the app MUST refuse to start with a clear error. When the bypass is active the `COGNITO_*` variables MUST be optional; otherwise they remain required. Boot MUST log a WARN when the bypass is active. A config test MUST assert the guard and the optional `COGNITO_*` behavior.

Source: dev-harness

#### Scenario: Bypass in production

- GIVEN `NODE_ENV=production` and `AUTH_DEV_BYPASS=true`
- WHEN configuration is loaded
- THEN the app fails fast and does not start

#### Scenario: Bypass active in development

- GIVEN `NODE_ENV=development` and `AUTH_DEV_BYPASS=true`
- WHEN the app boots without `COGNITO_*`
- THEN it starts and logs a WARN

## History

| Requirement | Source | Superseded by |
|---|---|---|
| Service-agent authentication denied fail-closed everywhere (`machine_credential` created but unused) | auth-two-gate | promotion-pipeline (`authorizePromote` for `/promote`; `/mcp` still denies, kept above) |
