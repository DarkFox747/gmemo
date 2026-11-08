# Exploration: web-api-and-review-queue (C2)

One crombie-explore scope (HTTP/auth surface). Status: COMPLETE. Evidence is file:line against the C0/C1 tree.

## Reusable
- **Gate 1**: `Authenticator.authenticate(authorization) → Principal{subject, clientId, scopes}` (`src/mcp/context.ts:80-99`). The Cognito implementation is reusable as is.
- **Gate 2**: `RdsAuthorizer.authorize(principal, tenant, tool)` checks enabled app_user + membership; write tools need a role in {project_admin, contributor, service_agent} (`src/auth/authorizer.ts:42-95`). Denials are opaque and identical. Platform roles do not bypass membership.
- **Chain template**: authenticate → resolveTenant → authorize → audit → handler (`src/mcp/tools/index.ts:73-97`).
- **Rate limiter factory**: right-most XFF key, opaque 429 (`src/http/rateLimit.ts:33-65`). Config pattern `RATE_LIMIT_*` plus prod guard.
- **Test fakes**: `InMemoryAuthRepository`, `makeStubAuthServices` (`tests/auth/fakes.ts:108-363`). Opacity test pattern in `tests/auth/opacity.test.ts`.

## Gaps
- `DevAuthenticator` ignores input and returns a fixed principal. `X-Dev-User` needs a seam extension. `app_user.email` is UNIQUE NOT NULL, so lookup by email is cheap (`migrations/0001:13-18`). There is no `findEnabledUserByEmail`.
- `TenantContext` requires `repoId`/`branch` and is resolved from `X-Git-Remote` only, so it is not usable for `:projectId` routes.
- No project_admin-only check. `ToolName` is MCP-specific.
- `ActorIdentity.actorId` is the idp_subject. The `app_user.id` is fetched but dropped (needed for `reviewed_by`/`approved_by`).
- No "my projects with role" query.
- `AppError` has no NOT_FOUND. There is **no HTTP error mapper**: the terminal handler returns 500 for everything, including `/promote` denials.
- Audit types are narrow (`recordRead(ctx, ToolName)`, `recordWrite` for remember/discard). `access_log.action` has `update`/`admin`.
- `/promote`: strict body; ref == source_branch == default branch, which blocks `closed_unmerged` from a feature branch. `promote.yml` triggers on push to main only.
- No session-level discard. The `staging_status` enum has `abandoned`, and `ux_session_open` is partial on `open`.
- Helmet is global with CSP off. There is no static serving and no `WEB_STATIC_DIR`.
- Seed has only `dev@localhost` (contributor). C8 adds tl@/dev@/viewer@demo.local.

## Risks
- `X-Dev-User` becomes a backdoor if the guard is not layered exactly like `AUTH_DEV_BYPASS`.
- Relaxing the `/promote` branch checks for `closed_unmerged` must not weaken the "promotion only from the default branch" guarantee.
- Widening `ToolName` widens the MCP surface. Keep REST actions separate.
