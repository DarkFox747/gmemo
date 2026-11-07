# Exploration — Auth Two-Gate (Cognito JWT + RBAC)

schema: exploration-synthesis-v1
change: auth-two-gate
sources: 2 crombie-explore agents (auth design detail · scaffold code seams)

## The two gates

- **Gate 1 — token-only, NO DB (stateless):** verify JWT signature against Cognito JWKS;
  validate `iss`, `token_use=access`, `exp`, `client_id ∈ allowlist`, required `scope`.
  Cognito access tokens carry `client_id`+`scope` and **NO `aud`** → must NOT validate aud.
  Domain (@<COMPANY_DOMAIN>) is enforced by a Cognito Lambda trigger, not the resource server.
- **Gate 2 + RBAC + tenant + audit — ALL require RDS:**
  - Tenant resolution: `repo.remote_url` (UNIQUE natural key) → `repo.project_id` → project.
  - Gate 2 (human): `app_user WHERE idp_subject = <JWT sub> AND disabled_at IS NULL`.
  - Gate 2 (machine/service-agent): separate `machine_credential` path — `token_hash`
    (constant-time compare), `revoked_at IS NULL`, `expires_at > now()`, `project_id` match.
  - RBAC (read tools): viewer+ = any `project_membership(user_id, project_id) → role` row.
  - Audit: INSERT `access_log(actor_identity, actor_kind, action=read, project_id, query_hash)`
    on EVERY read — `query_hash` computed **server-side**, never client-supplied.

## RDS columns the enforcement needs (schema v2)
- `app_user`: idp_subject (UNIQUE), global_role enum(platform_owner|platform_admin, nullable), disabled_at
- `project_membership`: project_id, user_id, role enum(project_admin|contributor|viewer|service_agent), UNIQUE(project_id,user_id)
- `machine_credential`: project_id, token_hash, role default service_agent, expires_at, revoked_at
- `repo`: remote_url (UNIQUE), project_id
- `access_log`: actor_identity, actor_kind enum(user|agent|ci|system), action, project_id, query_hash

## Scaffold seams (current code)
- Interfaces (src/mcp/context.ts): `TenantResolver.resolve(TenantResolutionInput)→TenantContext`;
  `Authorizer.authorize(ctx, tool)→void (throws AppError PERMISSION_DENIED)`;
  `AuditLogger.recordRead(ctx, tool, queryHash?)`.
  Types: `TenantResolutionInput={authorization?, gitRemote?, branch?}`,
  `TenantContext={projectId,repoId,branch}`, `ActorIdentity={actorId, roles[]}`,
  `RequestContext={tenant, actor}`.
- Call order per tool (tools/index.ts): resolveTenant → build ctx (with PLACEHOLDER_ACTOR)
  → authorize → auditRead → handler → catch→toToolErrorResult (opaque).
- `Authorization` header IS forwarded (transport.ts) into `resolutionInput.authorization`.
  `gitRemote`/`branch` are hardcoded `undefined` (TODO) — no client mechanism yet.
- `PERMISSION_DENIED` already exists and maps to opaque "Access denied." ✓
- Missing: JWT/JWKS lib, `pg`/DB client; config has only PORT/HOST/NODE_ENV/LOG_LEVEL.
- Placeholders are `new`-ed per request → real (JWKS-caching / DB-pool) impls must be
  singletons injected at boot; transport must accept pre-built deps.

## Key edit points
| File | Change |
|------|--------|
| src/config/index.ts | Add COGNITO_ISSUER, COGNITO_JWKS_URI, COGNITO_CLIENT_ID (allowlist), DATABASE_URL |
| package.json | Add JWT/JWKS lib (jose or aws-jwt-verify) + DB client (pg) + migration tool |
| src/mcp/context.ts | Real impls; source ActorIdentity from JWT+RDS (fix the actor gap) |
| src/mcp/transport.ts | Singleton dep injection; extract gitRemote/branch from request |
| src/mcp/tools/index.ts | Replace PLACEHOLDER_ACTOR with JWT/RDS-derived actor |

## ActorIdentity gap — resolution
ActorIdentity is not produced by any seam today. Cleanest fit given the auth chain:
authenticate (Gate 1, token→principal) → resolve tenant → authorize (Gate 2 + RBAC,
returns the resolved ActorIdentity{actorId, roles}). The wrapper builds `ctx.actor` from
what the Authorizer returns, since roles come from RDS `project_membership`, not the token.

## Open decisions (surfaced to proposal)
1. **gitRemote/branch transport**: MCP has no standard git field. Pilot proposal: custom
   headers `X-Git-Remote` / `X-Git-Branch`, server-validated; real client hook is a skill concern.
2. **Machine/service-agent flow**: does client_credentials come as a Cognito token (Gate 1)
   or a raw bearer secret hashed against `machine_credential` (bypassing Gate 1)? Schema
   stores token_hash independent of Cognito → ambiguous.
3. **Global-role bypass**: do platform_owner/admin bypass project_membership for reads?
4. **B↔C boundary**: which tables/DB-layer land in C vs B.
5. **ActorIdentity canonical format** for access_log (raw sub vs sub:email).
6. JWKS cache TTL / key-rotation refresh-on-unknown-kid.

## Risks
- Two Gate-2 paths (human + machine) must both be handled; a fail-OPEN placeholder for
  either is unsafe (a fail-CLOSED deny placeholder is safe).
- machine_credential.token_hash compare must be constant-time (timing attack).
- Prefer RDS `global_role` over any stale token claim.
- Per-request construction of a JWKS/DB client would refetch/reconnect every call.
- Config lacks auth env → fail-fast won't catch missing COGNITO_* until envSchema extended.
