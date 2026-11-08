/**
 * Shared types for the REST layer (/api): router deps/options, error bodies and DTOs.
 * JSON is camelCase; timestamps are ISO-8601 strings.
 */

import type express from 'express';
import type {
  AdminActor,
  ApiWriteAudit,
  AuditLogger,
  Authenticator,
  Authorizer,
  Principal,
  ProjectContext,
  ProjectMember,
  ProjectRole,
} from '../../mcp/context.js';
import type { AuthRepository } from '../../db/authRepository.js';
import type { MemoryType } from '../../contracts/memory.js';
import type { DecisionCriterion, Verdict } from '../../judge/judge.js';
import type { QuarantineCriterion, QuarantineReasonCode } from '../../quarantine/reason.js';
import type { QuarantineServiceLike } from '../../quarantine/quarantineService.js';
import type { LifecycleServiceLike } from '../../lifecycle/types.js';
import type { MemoryStatus } from '../../db/memoryAdminRepository.js';
import type { DirectMemoryServiceLike } from '../../memory/types.js';
import type { AdminSummaryRepository } from '../../db/adminSummaryRepository.js';

/**
 * Approve outcomes the caller can fix by reloading the item.
 * Declared here; the promotion repository (batch C) re-exports it.
 */
export type ConflictCode =
  | 'target_changed'
  | 'target_inactive'
  | 'duplicate_content'
  /** C5 SEC-L4: a direct add whose content equals a non-active memory. */
  | 'duplicate_inactive';

export interface ApiLocals {
  principal: Principal;
  actor?: AdminActor;
  /** Set by makeProjectMember (quarantine routes, C3). */
  member?: ProjectMember;
  project?: ProjectContext;
}

export type ApiResponse = express.Response<unknown, ApiLocals>;

export interface QueueQueryInput {
  filter: 'all' | 'uncertain' | 'mandatory';
  type?: MemoryType;
  limit: number;
}
export interface ApproveInput {
  markRelatedSuperseded: boolean;
  targetRevision?: number;
}
export interface RejectInput {
  reason: string;
}

export type ApproveOutcome =
  | { kind: 'approved'; dto: ApproveResponseDto }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: ConflictCode };

export type RejectOutcome =
  { kind: 'rejected'; dto: RejectResponseDto } | { kind: 'not_found' } | { kind: 'invalid_reason' };

/**
 * Review service surface consumed by the routes; implemented in src/review/reviewService.ts.
 * `audit` (C11) writes the route's access_log row in the decision's own
 * transaction; it runs only when the decision is written.
 */
export interface ReviewServiceLike {
  list(projectId: string, q: QueueQueryInput): Promise<ReviewQueueListDto>;
  get(projectId: string, itemId: string): Promise<ReviewItemDetailDto | null>;
  approve(
    actor: AdminActor,
    projectId: string,
    itemId: string,
    b: ApproveInput,
    audit: ApiWriteAudit,
  ): Promise<ApproveOutcome>;
  reject(
    actor: AdminActor,
    projectId: string,
    itemId: string,
    b: RejectInput,
    audit: ApiWriteAudit,
  ): Promise<RejectOutcome>;
}

export interface ApiRouterDeps {
  authenticator: Authenticator;
  authorizer: Authorizer;
  auditLogger: AuditLogger;
  /** Only the /me project list is needed by the routes. */
  authRepository: Pick<AuthRepository, 'listProjectsForUser'>;
  reviewService: ReviewServiceLike;
  /** Quarantine list/detail/restore (C3). */
  quarantineService: QuarantineServiceLike;
  /** Memory lifecycle routes (C4). */
  lifecycleService: LifecycleServiceLike;
  /** Direct memory management: list, detail, preview, create, amend (C5). */
  directMemoryService: DirectMemoryServiceLike;
  /** Read-only administration summary (C7). */
  adminSummaryRepository: AdminSummaryRepository;
}

export interface ApiRouterOptions {
  /** Forward X-Dev-User to the authenticator (dev only; ignored in production). */
  devUserHeader: boolean;
}

export type ApiErrorBody =
  | {
      error:
        | 'Unauthorized'
        | 'Not found'
        | 'Invalid request'
        | 'Internal server error'
        | 'Too Many Requests';
    }
  | { error: 'Conflict'; code: ConflictCode }
  | { error: 'Service unavailable'; code: 'evaluation_unavailable' };

export interface MeDto {
  user: { id: string; email: string; displayName: string | null };
  projects: Array<{ id: string; slug: string; name: string; role: string }>;
}

export interface ReviewQueueItemDto {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  judgeState: 'pending' | 'accepted' | 'uncertain';
  criterion: DecisionCriterion | null;
  confidence: number | null;
  mandatoryReview: boolean;
  originBranch: string;
  originPr: number | null;
  author: string;
  createdAt: string;
}

export interface ReviewQueueCountersDto {
  pending: number;
  uncertain: number;
  mandatory: number;
  resolvedLast7Days: number;
}

export interface ReviewQueueListDto {
  items: ReviewQueueItemDto[];
  counters: ReviewQueueCountersDto;
  truncated: boolean;
}

export interface MemoryRefDto {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  version: number;
  originBranch: string | null;
  originPr: number | null;
  updatedAt: string;
}

export interface ReviewItemDetailDto extends ReviewQueueItemDto {
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  reason: string | null;
  threshold: number;
  sanitizeFlags: { pii?: string[]; injection?: string[]; secrets?: string[]; leak?: true };
  targetRevision: number | null;
  target: MemoryRefDto | null;
  related: MemoryRefDto | null;
  targetStale: boolean;
}

export interface ApproveResponseDto {
  itemId: string;
  decision: 'approved';
  memoryId: string;
  deduped: boolean;
  rebasedFromRevision: number | null;
  relatedSuperseded: boolean;
}

export interface RejectResponseDto {
  itemId: string;
  decision: 'rejected';
}

// ---------------------------------------------------------------------------
// Quarantine (C3, HU-10)
// ---------------------------------------------------------------------------

export interface QuarantineItemDto {
  id: string;
  /** null only on a legacy row the 0008 backfill could not reach (never in practice). */
  reasonCode: QuarantineReasonCode | null;
  criterion: QuarantineCriterion | null;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  /** First 160 chars of the (already redacted) body. */
  excerpt: string;
  quarantinedAt: string;
  daysUntilExpiry: number | null;
}

export interface QuarantineListDto {
  items: QuarantineItemDto[];
  truncated: boolean;
}

export interface QuarantineDetailDto extends QuarantineItemDto {
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  /** Project admins only (SEC-L5); absent for authors. */
  judgeReason?: string;
  author: string;
  expiresAt: string | null;
  originBranch: string | null;
  originPr: number | null;
  related: MemoryRefDto | null;
  canRestore: boolean;
}

export type RestoreResponseDto =
  | { outcome: 'applied'; memoryId?: string }
  | { outcome: 'queued'; itemId: string }
  | { outcome: 'quarantined'; quarantineId?: string };

// ---------------------------------------------------------------------------
// Memory lifecycle (C4, HU-12, HU-11.4)
// ---------------------------------------------------------------------------

export interface MemoryListItemDto {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  version: number;
  provenance: string;
  originBranch: string | null;
  originPr: number | null;
  revalidateAt: string | null;
  updatedAt: string;
}

export interface MemoryListDto {
  items: MemoryListItemDto[];
  /** Opaque keyset cursor of the next page; null on the last page. */
  nextCursor: string | null;
  /** nextCursor !== null (C4 compatibility). */
  truncated: boolean;
}

/** C5: status (default active), type, free-text q, cursor, page size (default 20). */
export interface MemoryListQueryInput {
  status: MemoryStatus;
  type: MemoryType | null;
  q: string | null;
  cursor: string | null;
  limit: number;
}

export interface ConfirmResponseDto {
  memoryId: string;
  status: 'active';
  revalidateAt: string | null;
}

export interface RetireResponseDto {
  memoryId: string;
  status: 'deprecated';
  version: number;
}

export interface RetireByPrResponseDto {
  retired: number;
}

// ---------------------------------------------------------------------------
// Direct memory management (C5, HU-13)
// ---------------------------------------------------------------------------

export interface MemoryRevisionDto {
  revisionNo: number;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  /** Display name only; null when the author has none (SEC-L3). */
  author: string | null;
  createdAt: string;
}

export interface MemoryDetailDto {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  status: MemoryStatus;
  version: number;
  provenance: string;
  /** Display name only — never the email, idp subject or app_user id (SEC-L3). */
  author: string | null;
  /** Present when the current revision was human-approved; display name only. */
  approver: { name: string | null } | null;
  repo: { id: string; slug: string | null } | null;
  originBranch: string | null;
  originPr: number | null;
  createdAt: string;
  updatedAt: string;
  revalidateAt: string | null;
  retiredReason: string | null;
  /** Newest first, at most 100. */
  revisions: MemoryRevisionDto[];
  revisionsTruncated: boolean;
}

export interface PreviewResponseDto {
  /**
   * What a confirm would do. 'unavailable': the judge or its context failed
   * closed, so a confirm is refused with 503 evaluation_unavailable (SEC-M2).
   */
  outcome: 'apply' | 'quarantine' | 'unavailable';
  /** What an agent promotion of the same unit would do. */
  withoutApproval: 'apply' | 'queue_uncertain' | 'queue_mandatory' | 'quarantine';
  pipeline: {
    blocked: boolean;
    reasonCode: 'secret_detected' | 'embedded_instructions' | 'sanitize_failed' | null;
    /** Detector categories only, never matched text. */
    findings: { secrets?: string[]; injection?: string[]; pii?: string[] };
  };
  /** Masked content as it would be stored; null when it is not provably secret-free. */
  preview: { title: string; summary: string; body: string; fields: Record<string, unknown> } | null;
  /** null when the pipeline blocked the unit (the judge is not called). */
  judge: null | {
    verdict: Verdict;
    criterion: DecisionCriterion;
    confidence: number | null;
    threshold: number;
    reason: string;
    related: MemoryRefDto | null;
  };
  quarantineReasonCode: QuarantineReasonCode | null;
}

export type DirectWriteResponseDto =
  | { outcome: 'applied'; deduped: boolean; memory: MemoryDetailDto }
  | {
      outcome: 'quarantined';
      quarantineId: string;
      reasonCode: QuarantineReasonCode | null;
      criterion: QuarantineCriterion | null;
    };

// ---------------------------------------------------------------------------
// Administration summary (C7, read-only; never a token or token hash)
// ---------------------------------------------------------------------------

export interface AdminSummaryDto {
  project: { id: string; slug: string; name: string; createdAt: string };
  repos: Array<{
    id: string;
    remoteUrl: string;
    slug: string | null;
    provider: string | null;
    defaultBranch: string;
    createdAt: string;
  }>;
  members: Array<{
    userId: string;
    email: string;
    displayName: string | null;
    role: ProjectRole;
    grantedAt: string;
    disabled: boolean;
  }>;
  credentials: Array<{
    id: string;
    principalName: string;
    role: ProjectRole;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
    status: 'active' | 'expired' | 'revoked';
  }>;
}
