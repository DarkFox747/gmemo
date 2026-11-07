/**
 * Registers all three read tools on the McpServer.
 *
 * Each registration wraps the pure handler with the two-gate auth + audit chain
 * in the contract-mandated order:
 *   1. authenticate(authorization)        — Gate 1: verify Cognito JWT → Principal
 *   2. resolveTenant(resolutionInput)     — derive TenantContext from git remote
 *   3. authorize(principal, tenant, tool) — Gate 2 + RBAC → ActorIdentity
 *   4. build RequestContext from ActorIdentity (no placeholder actor)
 *   5. auditRead(ctx, tool, queryHash)    — write access_log (server-side SHA-256 hash)
 *   6. handler(input, ctx, deps)
 *
 * Any exception — from auth, seams, or handler — is caught and routed through
 * toToolErrorResult() so errors are always opaque to the caller (contract §6;
 * no tenant/resource/stack detail leaks). Unexpected (non-AppError) exceptions
 * are additionally logged server-side before the opaque response is returned.
 *
 * query_hash is computed server-side so raw query text never reaches access_log:
 *  - recall:      sha256Hex of the normalized (trim + lowercase) query string
 *  - get_memory:  sha256Hex of the handle
 *  - get_context: no query, hash omitted (undefined)
 *
 * The `as unknown as CallToolResult` casts at return sites are necessary because
 * ToolTextResult lacks the `[x: string]: unknown` index signature that the SDK's
 * CallToolResult inherits from its Result base. The cast is safe: the runtime
 * shape is compatible.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toToolResult, toToolErrorResult } from '../../errors/toToolResult.js';
import type { Deps, RequestContext } from '../context.js';
import {
  recallInputShape,
  getMemoryInputShape,
  getContextInputShape,
  rememberInputShape,
  listStagedInputShape,
  discardStagedInputShape,
} from './schemas.js';
import { recallHandler } from './recall.js';
import { getMemoryHandler } from './getMemory.js';
import { getContextHandler } from './getContext.js';
import { rememberHandler } from './remember.js';
import { listStagedHandler } from './listStaged.js';
import { discardStagedHandler } from './discardStaged.js';
import type {
  GetContextRequest,
  GetMemoryRequest,
  RecallRequest,
  RememberRequest,
  RememberResponse,
  DiscardStagedRequest,
} from '../../contracts/tools.js';
import { sha256Hex } from '../../security/hash.js';
import { AppError } from '../../errors/appError.js';
import { logger } from '../../observability/logger.js';

/**
 * Adapts ToolTextResult to CallToolResult for the SDK callback return type.
 * Safe: the runtime shape is fully compatible; only the index signature differs.
 */
function asCTR(r: ReturnType<typeof toToolResult> | ReturnType<typeof toToolErrorResult>): CallToolResult {
  return r as unknown as CallToolResult;
}

/**
 * Registers recall, get_memory, and get_context on the given McpServer.
 * Called once per per-request server instance (stateless transport pattern).
 */
export function registerReadTools(server: McpServer, deps: Deps): void {
  // --- recall ---
  server.tool(
    'recall',
    'Hybrid search over project memory (BM25 + semantic). Returns ranked whole records with time-decay.',
    recallInputShape,
    async ({ query, scope, types, limit, cursor }) => {
      try {
        const input: RecallRequest = { query, scope, types, limit, cursor };
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'recall');
        const ctx: RequestContext = { tenant, actor };
        // Hash the normalized query server-side; raw text never enters access_log.
        const queryHash = sha256Hex(input.query.trim().toLowerCase());
        await deps.auditLogger.recordRead(ctx, 'recall', queryHash);
        const result = await recallHandler(input, ctx, deps);
        return asCTR(toToolResult(result));
      } catch (err) {
        // Log unexpected errors server-side before returning the opaque response.
        if (!(err instanceof AppError)) {
          logger.error('[tool:recall] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );

  // --- get_memory ---
  server.tool(
    'get_memory',
    'Fetch one memory record in full detail: body, relations (supersedes/conflicts_with), and references.',
    getMemoryInputShape,
    async ({ handle }) => {
      try {
        const input: GetMemoryRequest = { handle };
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'get_memory');
        const ctx: RequestContext = { tenant, actor };
        // Hash the handle server-side; raw handle never enters access_log.
        const queryHash = sha256Hex(input.handle);
        await deps.auditLogger.recordRead(ctx, 'get_memory', queryHash);
        const result = await getMemoryHandler(input, ctx, deps);
        return asCTR(toToolResult(result));
      } catch (err) {
        // Log unexpected errors server-side before returning the opaque response.
        if (!(err instanceof AppError)) {
          logger.error('[tool:get_memory] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );

  // --- get_context ---
  server.tool(
    'get_context',
    'Session primer: returns all active constraints and domain rules (never budget-dropped), plus recent decisions and gotchas.',
    getContextInputShape,
    async (_args) => {
      try {
        const input: GetContextRequest = {};
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'get_context');
        const ctx: RequestContext = { tenant, actor };
        // get_context has no query; query_hash is omitted.
        await deps.auditLogger.recordRead(ctx, 'get_context');
        const result = await getContextHandler(input, ctx, deps);
        return asCTR(toToolResult(result));
      } catch (err) {
        // Log unexpected errors server-side before returning the opaque response.
        if (!(err instanceof AppError)) {
          logger.error('[tool:get_context] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );
}

/**
 * Registers the three write tools (remember, list_staged, discard_staged) on the McpServer.
 *
 * Auth/audit chain order follows the same 6-step wrapper as registerReadTools, with one
 * intentional divergence for remember (Decision 6 in write-path design.md):
 *   1. authenticate(authorization)        — Gate 1: verify Cognito JWT → Principal
 *   2. resolveTenant(resolutionInput)     — derive TenantContext from git remote
 *   3. authorize(principal, tenant, tool) — Gate 2 + RBAC (WRITE_ROLES enforced) → ActorIdentity
 *   4. build RequestContext from ActorIdentity
 *   5. handler(input, ctx, deps)          — for remember: scan + insert happen here
 *   6. (remember + discard_staged) auditLogger.recordWrite(ctx, { tool, itemId, ... })
 *      Audit is AFTER the handler; a refused/not-found op never reaches this step.
 *      Wrapped in its own try/catch: audit failure never fails a persisted op (L2).
 *      list_staged is NOT audited.
 *
 * Error handling mirrors registerReadTools: non-AppError exceptions are logged server-side;
 * all exceptions return an opaque toToolErrorResult (no stack/tenant/resource detail leaked).
 */
export function registerWriteTools(server: McpServer, deps: Deps): void {
  // --- remember ---
  server.tool(
    'remember',
    'Stage a memory item (add, amend, supersede, or deprecate). Writes to a session-scoped staging buffer; nothing is promoted to main storage until a human or judge approves.',
    rememberInputShape,
    async ({ op, type, title, summary, body, fields, target_handle }) => {
      try {
        const input: RememberRequest = { op, type, title, summary, body, fields, target_handle };
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'remember');
        const ctx: RequestContext = { tenant, actor };
        const result = await rememberHandler(input, ctx, deps);
        // Decision 6: audit AFTER handler succeeds — a refused stage must not produce an audit row.
        // L2: audit failure must NOT make a persisted stage appear failed to the caller.
        try {
          await deps.auditLogger.recordWrite(ctx, {
            tool: 'remember',
            sessionId: result.sessionId,
            itemId: result.id,
            contentHash: result.contentHash,
          });
        } catch (auditErr) {
          logger.error('[tool:remember] Audit write failed; stage was persisted', auditErr);
        }
        const response: RememberResponse = { id: result.id, state: result.state };
        return asCTR(toToolResult(response));
      } catch (err) {
        if (!(err instanceof AppError)) {
          logger.error('[tool:remember] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );

  // --- list_staged ---
  server.tool(
    'list_staged',
    "List all staging items in the caller's own open session, ordered newest first. Returns an empty list when no open session exists.",
    listStagedInputShape,
    async (_args) => {
      try {
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'list_staged');
        const ctx: RequestContext = { tenant, actor };
        const result = await listStagedHandler({} as Record<string, never>, ctx, deps);
        return asCTR(toToolResult(result));
      } catch (err) {
        if (!(err instanceof AppError)) {
          logger.error('[tool:list_staged] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );

  // --- discard_staged ---
  server.tool(
    'discard_staged',
    "Remove one staging item from the caller's own open session. Returns an opaque error when the item is not found in the caller's session (no cross-session enumeration).",
    discardStagedInputShape,
    async ({ item_id }) => {
      try {
        const input: DiscardStagedRequest = { item_id };
        const principal = await deps.authenticator.authenticate(deps.resolutionInput.authorization);
        const tenant = await deps.tenantResolver.resolve(deps.resolutionInput);
        const actor = await deps.authorizer.authorize(principal, tenant, 'discard_staged');
        const ctx: RequestContext = { tenant, actor };
        const result = await discardStagedHandler(input, ctx, deps);
        // REQ-20: audit AFTER a successful discard. If the handler threw
        // INVALID_REFERENCE (not found) this line is never reached — correct.
        // L2: audit failure must NOT make a persisted discard appear failed.
        try {
          await deps.auditLogger.recordWrite(ctx, {
            tool: 'discard_staged',
            itemId: input.item_id,
          });
        } catch (auditErr) {
          logger.error('[tool:discard_staged] Audit write failed; discard was persisted', auditErr);
        }
        return asCTR(toToolResult(result));
      } catch (err) {
        if (!(err instanceof AppError)) {
          logger.error('[tool:discard_staged] Unexpected error', err);
        }
        return asCTR(toToolErrorResult(err));
      }
    },
  );
}
