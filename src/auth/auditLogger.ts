/**
 * Audit logger: writes one access_log row per authorized read.
 *
 * RdsAuditLogger is called ONLY after the full auth chain (Gate 1 + tenant
 * resolution + Gate 2/RBAC) has succeeded. Unauthorized attempts are never
 * logged — this is intentional: an audit record implies the read happened.
 *
 * query_hash: the caller (tool wrapper) computes sha256Hex(query) server-side
 * and passes the digest here. The raw query text is NEVER passed to this
 * logger and is never written to access_log. Callers without a meaningful
 * query (e.g. get_context) omit the parameter; it is stored as NULL.
 */

import type { AuthRepository } from '../db/authRepository.js';
import type { AuditLogger, RequestContext, ToolName } from '../mcp/context.js';

export class RdsAuditLogger implements AuditLogger {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Inserts one access_log row for an authorized read.
   *
   * @param ctx       - Fully resolved request context (tenant + actor).
   * @param tool      - The MCP tool that performed the read.
   * @param queryHash - Server-side SHA-256 hex digest of the query (omit for
   *                    tools that carry no query, e.g. get_context).
   */
  async recordRead(
    ctx: RequestContext,
    tool: ToolName,
    queryHash?: string,
  ): Promise<void> {
    await this.repo.insertAccessLog({
      actorIdentity: ctx.actor.actorId,
      actorKind: 'user',
      action: 'read',
      projectId: ctx.tenant.projectId,
      queryHash,
      detail: {
        tool,
        repoId: ctx.tenant.repoId,
      },
    });
  }

  /**
   * Inserts one access_log row for a successful staging write or discard.
   *
   * Called AFTER the handler succeeds (Decision 6): the audit row reflects
   * an action that actually happened, not an attempt that may have been refused.
   *
   * - For 'remember': sessionId and contentHash are present (SHA-256 hex digest).
   * - For 'discard_staged': sessionId and contentHash are omitted; query_hash is null.
   *
   * The tool name is stored in detail so a single 'stage' action covers both ops
   * without adding a new access_action enum value.
   *
   * @param ctx    - Fully resolved request context (tenant + actor).
   * @param params - Tool name, optional session/content-hash, and item id.
   */
  async recordWrite(
    ctx: RequestContext,
    params: {
      tool: 'remember' | 'discard_staged';
      sessionId?: string;
      itemId: string;
      contentHash?: string;
    },
  ): Promise<void> {
    await this.repo.insertAccessLog({
      actorIdentity: ctx.actor.actorId,
      actorKind: 'user',
      action: 'stage',
      projectId: ctx.tenant.projectId,
      sessionId: params.sessionId,
      queryHash: params.contentHash, // a hash already; no raw text (undefined for discard)
      detail: {
        tool: params.tool,
        repoId: ctx.tenant.repoId,
        branch: ctx.tenant.branch,
        itemId: params.itemId,
      },
    });
  }

  /**
   * Inserts one access_log row for a completed promotion run.
   *
   * actorKind is 'ci' (GitHub Actions OIDC identity).
   * action is 'promote' (distinct from 'stage').
   * Raw content is never stored — only session/memory IDs and counters.
   *
   * @param ctx - Fully resolved request context (tenant + actor derived from machine_credential).
   * @param p   - Promotion outcome counters + traceability ids.
   */
  async recordPromote(
    ctx: RequestContext,
    p: {
      sessionId: string;
      applied: number;
      quarantined: number;
      uncertain: number;
      prNumber: number | null;
      mergeSha: string | null;
    },
  ): Promise<void> {
    await this.repo.insertAccessLog({
      actorIdentity: ctx.actor.actorId,
      actorKind: 'ci',
      action: 'promote',
      projectId: ctx.tenant.projectId,
      sessionId: p.sessionId,
      detail: {
        sessionId: p.sessionId,
        applied: p.applied,
        quarantined: p.quarantined,
        uncertain: p.uncertain,
        prNumber: p.prNumber,
        mergeSha: p.mergeSha,
        repoId: ctx.tenant.repoId,
      },
    });
  }
}
