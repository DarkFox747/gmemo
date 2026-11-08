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

import type { MemoryType } from '../contracts/memory.js';
import type { MemoryRepository } from '../db/memoryRepository.js';
import type { StagingRepository } from '../db/stagingRepository.js';
import type { PromotePrincipal, OidcVerifier } from '../auth/oidcAuthenticator.js';
import type { PromotionRepository } from '../db/promotionRepository.js';
import type { Judge } from '../judge/judge.js';
import type { PromoteServiceLike } from '../promote/promoteService.js';
import type { AuthRepository, TxnAudit } from '../db/authRepository.js';
import type { Embedder } from '../embedder/embedder.js';
import type { Notifier } from '../notify/notifier.js';
import type { ReviewServiceLike } from '../http/api/types.js';
import type { QuarantineReasonCode } from '../quarantine/reason.js';
import type { QuarantineServiceLike } from '../quarantine/quarantineService.js';
import type { LifecycleServiceLike } from '../lifecycle/types.js';
import type { DirectMemoryServiceLike } from '../memory/types.js';
import type { AdminSummaryRepository } from '../db/adminSummaryRepository.js';
import type { InsightsRepository } from '../db/insightsRepository.js';

// ---------------------------------------------------------------------------
// Core identity / context types
// ---------------------------------------------------------------------------

/** Project-only context (REST routes have no repo or branch). */
export interface ProjectContext {
  projectId: string;
}

/** Tenant-scoped project/repo/branch context resolved per-request by TenantResolver. */
export interface TenantContext extends ProjectContext {
  repoId: string;
  branch: string;
}

/** Caller identity derived from RDS project_membership by Authorizer (Gate 2). */
export interface ActorIdentity {
  /** idp_subject (users) | OIDC repository (CI). */
  actorId: string;
  /** app_user.id; null on the machine (/promote) path. */
  userId: string | null;
  roles: string[];
}

/** Actor proven to be project_admin of ProjectContext.projectId. */
export interface AdminActor extends ActorIdentity {
  userId: string;
}

/** project_membership.role values. */
export type ProjectRole = 'project_admin' | 'contributor' | 'viewer' | 'service_agent';

/** Actor proven to be a member (any role) of ProjectContext.projectId (C3). */
export interface ProjectMember extends ActorIdentity {
  userId: string;
  projectRole: ProjectRole;
}

/** Gate-2-only identity for /me. */
export interface AuthenticatedUser {
  actorId: string;
  userId: string;
  email: string;
  displayName: string | null;
  globalRole: string | null;
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
  | 'recall'
  | 'get_memory'
  | 'get_context'
  | 'remember'
  | 'list_staged'
  | 'discard_staged'
  | 'promote'; // audit typing only — NOT in WRITE_TOOLS; promote never flows through authorize()

/** REST audit/authorization actions - deliberately NOT part of ToolName (MCP surface unchanged). */
export type ApiAction =
  | 'me.read'
  | 'review_queue.list'
  | 'review_queue.read'
  | 'review_queue.approve'
  | 'review_queue.reject'
  | 'quarantine.list'
  | 'quarantine.read'
  | 'quarantine.restore'
  | 'memories.list'
  | 'memory.confirm'
  | 'memory.retire'
  | 'memory.retire_by_pr'
  | 'memory.read'
  | 'memory.preview'
  | 'memory.create'
  | 'memory.amend'
  /** C7 read-only administration view. */
  | 'admin_summary.read'
  /** C12 read-only governance insights. */
  | 'dashboard.read'
  | 'activity.list'
  | 'staging.list';

/** Audit detail for REST actions - ids and counters only, never titles, bodies or reasons. */
export interface ApiAuditDetail {
  itemId?: string;
  memoryId?: string;
  /** Review-queue filter, or the quarantine reason filter. */
  filter?: 'all' | 'uncertain' | 'mandatory' | QuarantineReasonCode;
  type?: MemoryType;
  resultCount?: number;
  decision?: 'approved' | 'rejected';
  deduped?: boolean;
  rebasedFromRevision?: number;
  rebasedToRevision?: number;
  relatedSuperseded?: boolean;
  quarantineId?: string;
  outcome?: 'applied' | 'queued' | 'quarantined';
  newQuarantineId?: string;
  /** Memory list status filter (C4). */
  status?: string;
  /** Retire-by-PR target PR number (C4). */
  originPr?: number;
  /** sha256Hex of the normalized list search (C5); stored in access_log.query_hash, never in detail. */
  queryHash?: string;
  /** What a confirm would do, from a preview (C5). */
  previewOutcome?: 'apply' | 'quarantine' | 'unavailable';
}

/** A completed platform job run (C3 jobs router / scripts). Counts only. */
export interface JobAuditInput {
  job: string;
  count: number;
  /** Counts keyed by project id — never content. */
  detail?: Record<string, number>;
  trigger: 'http' | 'script';
}

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
export interface AuthenticateOptions {
  /** DEV ONLY. Honoured by DevAuthenticator; every other implementation MUST ignore it. */
  devUser?: string;
}

export interface Authenticator {
  authenticate(authorization: string | undefined, opts?: AuthenticateOptions): Promise<Principal>;
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
  /** Gate 2 only: enabled app_user. For /me. Opaque PERMISSION_DENIED on failure. */
  authorizeUser(principal: Principal): Promise<AuthenticatedUser>;
  /**
   * Gate 2 + membership.role === 'project_admin' on projectId. Platform roles do NOT bypass.
   * Throws the same opaque AppError(PERMISSION_DENIED) on every failure.
   */
  authorizeProjectAdmin(principal: Principal, projectId: string): Promise<AdminActor>;
  /**
   * Gate 2 + any membership on a non-archived projectId. Platform roles do NOT bypass (C2 D4).
   * Throws the same opaque AppError(PERMISSION_DENIED) on every failure.
   */
  authorizeProjectMember(principal: Principal, projectId: string): Promise<ProjectMember>;
}

/** Transaction-scoped audit of one REST write; detail is allow-listed as in recordApi. */
export type ApiWriteAudit = TxnAudit<ApiAuditDetail>;

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
  /**
   * Records a successful REST read/write (actor_kind 'user'). Never stores content.
   */
  recordApi(
    actor: ActorIdentity,
    project: ProjectContext | null,
    action: ApiAction,
    detail?: ApiAuditDetail,
  ): Promise<void>;
  /**
   * Binds actor, project and a REST write action into the hook the write's
   * repository runs inside its own transaction (C11): the access_log row
   * (same shape as recordApi) commits with the data change, and an insert
   * failure rolls the write back.
   */
  apiWriteAudit(actor: ActorIdentity, project: ProjectContext, action: ApiAction): ApiWriteAudit;
  /**
   * Records a closed_unmerged session abandon (actor_kind 'ci', action 'delete').
   */
  recordAbandon(
    ctx: RequestContext,
    p: { sessionId: string; discarded: number; prNumber: number },
  ): Promise<void>;
  /**
   * Records a completed platform job (actor_kind 'system', action 'admin',
   * project_id null). Counts only.
   */
  recordJob(p: JobAuditInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dependency bags
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into pure tool handlers (input, ctx, deps).
 * memoryRepository is the data-access seam added in change B (D7).
 * stagingRepository is added in the write-path slice (Batch B T007).
 * embedder is added for the hybrid-search RRF recall (query embedding).
 */
export interface HandlerDeps {
  memoryRepository: MemoryRepository;
  stagingRepository: StagingRepository;
  /** Embedder seam — used by the recall handler to embed the query (fail-soft). */
  embedder: Embedder;
  /** Best-effort review/leak notifications (call via safeNotify; never fails a write). */
  notifier: Notifier;
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
  /** Embedder seam — shared by PromoteService (write-time) and recall handler (query-time). */
  embedder: Embedder;
  /** Notifier seam — shared by remember (capture) and PromoteService. */
  notifier: Notifier;
  /** Human review queue (HU-07) — consumed by the /api review routes. */
  reviewService: ReviewServiceLike;
  /** Quarantine list/detail/restore (C3, HU-10) — consumed by the /api quarantine routes. */
  quarantineService: QuarantineServiceLike;
  /** Memory lifecycle: confirm/retire/retire-by-pr + revalidation sweep (C4). */
  lifecycleService: LifecycleServiceLike;
  /** Direct memory management: list/detail/preview/create/amend (C5, HU-13). */
  directMemoryService: DirectMemoryServiceLike;
  /** Read-only administration summary (C7) — consumed by the /api admin route. */
  adminSummaryRepository: AdminSummaryRepository;
  /** Read-only governance insights (C12) — consumed by the /api insights routes. */
  insightsRepository: InsightsRepository;
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
