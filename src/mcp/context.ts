/**
 * Request/tenant/actor context types and seam interfaces for the MCP facade.
 *
 * Two-gate auth model (auth-two-gate change):
 *  - Authenticator   Gate 1: verify Cognito JWT → Principal (throws on failure)
 *  - TenantResolver  resolve project/repo from git remote → TenantContext
 *  - Authorizer      Gate 2 + RBAC: enforce project_membership → ActorIdentity
 *  - AuditLogger     write access_log with server-side query_hash
 *
 * Boot-time singletons live in AuthServices; per-request header inputs in
 * TenantResolutionInput. Deps combines both for the tool-wrapper call chain:
 *   authenticate → resolveTenant → authorize(→ ActorIdentity) → audit → handler
 *
 * Change B (data-model): AppServices extends AuthServices with memoryRepository (D7).
 */

import type { MemoryRepository } from '../db/memoryRepository.js';
import type { StagingRepository } from '../db/stagingRepository.js';
import type { PromotePrincipal, OidcVerifier } from '../auth/oidcAuthenticator.js';
import type { PromotionRepository } from '../db/promotionRepository.js';
import type { Judge } from '../judge/judge.js';
import type { PromoteServiceLike } from '../promote/promoteService.js';
import type { AuthRepository } from '../db/authRepository.js';
import type { Embedder } from '../embedder/embedder.js';

// ---------------------------------------------------------------------------
// Core identity / context types
// ---------------------------------------------------------------------------

/** Tenant-scoped project/repo/branch context resolved per-request by TenantResolver. */
export interface TenantContext {
  projectId: string;
  repoId: string;
  branch: string;
}

/** Caller identity derived from RDS project_membership by Authorizer (Gate 2). */
export interface ActorIdentity {
  actorId: string;
  roles: string[];
}

/** Combined per-request context threaded through every tool handler. */
export interface RequestContext {
  tenant: TenantContext;
  actor: ActorIdentity;
}

/**
 * Per-HTTP-request inputs consumed by Authenticator and TenantResolver.
 * Populated by the transport layer from the raw Express request headers.
 */
export interface TenantResolutionInput {
  /** Raw HTTP Authorization header value (e.g. "Bearer <jwt>"). */
  authorization: string | undefined;
  /** Git remote URL reported by the client (contract §0). */
  gitRemote: string | undefined;
  /** Branch name reported by the client hook (contract §0). */
  branch: string | undefined;
}

// ---------------------------------------------------------------------------
// Tool name union (contract §2 / §4)
// ---------------------------------------------------------------------------

export type ToolName =
  | 'recall' | 'get_memory' | 'get_context'
  | 'remember' | 'list_staged' | 'discard_staged'
  | 'promote'; // audit typing only — NOT in WRITE_TOOLS; promote never flows through authorize()

// ---------------------------------------------------------------------------
// Gate-1 output: token-only principal (no RDS)
// ---------------------------------------------------------------------------

/**
 * Verified token claims produced by Gate 1 (Authenticator).
 * Contains only what the Cognito access token carries; no RDS data.
 * Passed to Authorizer to drive the membership lookup (Gate 2 / RBAC).
 */
export interface Principal {
  /** JWT `sub` claim — stable idp_subject used as actorId after Gate 2. */
  subject: string;
  /** Cognito `client_id` claim — audience-equivalent check (`aud` not present on access tokens). */
  clientId: string;
  /** Space-split `scope` claims from the access token. */
  scopes: string[];
}

// ---------------------------------------------------------------------------
// Seam interfaces
// ---------------------------------------------------------------------------

/**
 * SEAM — Gate 1: verify the Cognito access token and return a Principal.
 * Throws AppError(PERMISSION_DENIED) on any invalid, absent, or malformed token.
 */
export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

/** SEAM — resolve tenant from git remote (contract §0). */
export interface TenantResolver {
  resolve(input: TenantResolutionInput): Promise<TenantContext>;
}

/**
 * SEAM — Gate 2 + RBAC: enforce project_membership per request (contract §4).
 * Takes the Gate-1 principal and the resolved tenant; returns the ActorIdentity
 * derived from RDS. Throws AppError(PERMISSION_DENIED) if the user is absent,
 * disabled, or has no membership row for the project.
 */
export interface Authorizer {
  authorize(principal: Principal, tenant: TenantContext, tool: ToolName): Promise<ActorIdentity>;
  /**
   * Machine path for POST /promote — checks machine_credential (NOT app_user +
   * project_membership). Returns an ActorIdentity derived from the credential row.
   * Throws AppError(PERMISSION_DENIED) on any failure (opaque, no oracle).
   */
  authorizePromote(principal: PromotePrincipal, tenant: TenantContext): Promise<ActorIdentity>;
}

/** SEAM — write access_log (contract §7); query_hash only, never raw text. */
export interface AuditLogger {
  recordRead(ctx: RequestContext, tool: ToolName, queryHash?: string): Promise<void>;
  /**
   * Records a successful staging write or discard.
   * - For 'remember': sessionId and contentHash are present (SHA-256 hex digest).
   * - For 'discard_staged': sessionId and contentHash are omitted (no content to hash).
   * The tool name is stored in detail; action is always 'stage'.
   */
  recordWrite(
    ctx: RequestContext,
    params: {
      tool: 'remember' | 'discard_staged';
      sessionId?: string;
      itemId: string;
      contentHash?: string;
    },
  ): Promise<void>;
  /**
   * Records a completed promotion run.
   * actorKind is 'ci'; action is 'promote'; repoId is stored in detail.
   * Raw content is never stored — only counters and ids.
   */
  recordPromote(
    ctx: RequestContext,
    p: {
      sessionId: string;
      applied: number;
      quarantined: number;
      uncertain: number;
      prNumber: number | null;
      mergeSha: string | null;
    },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dependency bags
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into pure tool handlers (input, ctx, deps).
 * memoryRepository is the data-access seam added in change B (D7).
 * stagingRepository is added in the write-path slice (Batch B T007).
 * embedder, semanticFallbackMinResults, and semanticFallbackK are added
 * for the hybrid-search two-phase recall (lexical-first, semantic fallback).
 */
export interface HandlerDeps {
  memoryRepository: MemoryRepository;
  stagingRepository: StagingRepository;
  /** Embedder seam — used by the recall handler for Phase-2 query embedding. */
  embedder: Embedder;
  /** Threshold N: Phase 2 only fires when BM25 totalMatches < N. */
  semanticFallbackMinResults: number;
  /** k: number of nearest-neighbour rows to retrieve in Phase 2. */
  semanticFallbackK: number;
}

/**
 * Boot-time singleton services assembled once at process start and injected
 * through createApp(services) → makeMcpPostHandler(services).
 * These are process-level; none is created per-request.
 */
export interface AuthServices {
  authenticator: Authenticator;
  tenantResolver: TenantResolver;
  authorizer: Authorizer;
  auditLogger: AuditLogger;
}

/**
 * Full boot-time service bag: auth seams + memory data-access (D7) +
 * staging data-access (write-path slice) + promotion pipeline seams.
 * NOT an overload of AuthServices — kept separate so auth-only consumers
 * don't need to know about the data repositories.
 */
export interface AppServices extends AuthServices {
  memoryRepository: MemoryRepository;
  stagingRepository: StagingRepository;
  /** DB seam for promotion (apply/quarantine/finalize). */
  promotionRepository: PromotionRepository;
  /** Judge seam — DeterministicJudge (dev/test) or BedrockJudge (prod skeleton). */
  judge: Judge;
  /** OIDC verifier for POST /promote — DevOidcAuthenticator or GithubOidcAuthenticator. */
  oidcVerifier: OidcVerifier;
  /** Auth repository — also used by the promote path for machine_credential lookup. */
  authRepository: AuthRepository;
  /** Promotion orchestration service. */
  promoteService: PromoteServiceLike;
  /** Embedder seam — shared by PromoteService (write-time) and recall handler (Phase 2). */
  embedder: Embedder;
  /** Threshold N: Phase-2 semantic fallback fires when BM25 totalMatches < N. */
  semanticFallbackMinResults: number;
  /** k: number of nearest-neighbour rows to retrieve in Phase-2 semantic fallback. */
  semanticFallbackK: number;
}

/**
 * Full dependency bag used by createMcpServer and the tool-wrapper chain.
 * AuthServices are boot-level singletons; resolutionInput is built per-request
 * from the incoming HTTP headers by the transport layer.
 */
export interface Deps extends HandlerDeps, AuthServices {
  /** Per-HTTP-request inputs extracted from the transport layer. */
  resolutionInput: TenantResolutionInput;
}
