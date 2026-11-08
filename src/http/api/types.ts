/**
 * Shared types for the REST layer (/api): router deps/options, error bodies and DTOs.
 * JSON is camelCase; timestamps are ISO-8601 strings.
 */

import type express from 'express';
import type {
  AdminActor,
  ApiAuditDetail,
  AuditLogger,
  Authenticator,
  Authorizer,
  Principal,
  ProjectContext,
} from '../../mcp/context.js';
import type { AuthRepository } from '../../db/authRepository.js';
import type { MemoryType } from '../../contracts/memory.js';
import type { DecisionCriterion } from '../../judge/judge.js';

/**
 * Approve outcomes the caller can fix by reloading the item.
 * Declared here; the promotion repository (batch C) re-exports it.
 */
export type ConflictCode = 'target_changed' | 'target_inactive' | 'duplicate_content';

export interface ApiLocals {
  principal: Principal;
  actor?: AdminActor;
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
  | { kind: 'approved'; dto: ApproveResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: ConflictCode };

export type RejectOutcome =
  | { kind: 'rejected'; dto: RejectResponseDto }
  | { kind: 'not_found' }
  | { kind: 'invalid_reason' };

/** Review service surface consumed by the routes; implemented in src/review/reviewService.ts. */
export interface ReviewServiceLike {
  list(projectId: string, q: QueueQueryInput): Promise<ReviewQueueListDto>;
  get(projectId: string, itemId: string): Promise<ReviewItemDetailDto | null>;
  approve(actor: AdminActor, projectId: string, itemId: string, b: ApproveInput): Promise<ApproveOutcome>;
  reject(actor: AdminActor, projectId: string, itemId: string, b: RejectInput): Promise<RejectOutcome>;
}

export interface ApiRouterDeps {
  authenticator: Authenticator;
  authorizer: Authorizer;
  auditLogger: AuditLogger;
  /** Only the /me project list is needed by the routes. */
  authRepository: Pick<AuthRepository, 'listProjectsForUser'>;
  reviewService: ReviewServiceLike;
}

export interface ApiRouterOptions {
  /** Forward X-Dev-User to the authenticator (dev only; ignored in production). */
  devUserHeader: boolean;
}

export type ApiErrorBody =
  | { error: 'Unauthorized' | 'Not found' | 'Invalid request' | 'Internal server error' | 'Too Many Requests' }
  | { error: 'Conflict'; code: ConflictCode };

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
  status: 'active' | 'superseded' | 'deprecated';
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
