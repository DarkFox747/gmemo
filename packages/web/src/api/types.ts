/**
 * Hand-kept mirror of the /api/v1 JSON shapes the web consumes.
 *
 * Source of truth (the server is the moving side — update this file with it):
 *   - src/http/api/types.ts            DTOs, ConflictCode, ApiErrorBody, AdminSummaryDto (C7)
 *   - src/mcp/tools/schemas.ts         MEMORY_TYPES
 *   - src/db/memoryAdminRepository.ts  MemoryStatus
 *   - src/judge/judge.ts               Verdict, DecisionCriterion
 *   - src/quarantine/reason.ts         QUARANTINE_REASON_CODES, QUARANTINE_CRITERIA
 *   - src/mcp/context.ts               ProjectRole
 * Server code is never imported here: it pulls express and Node modules into the
 * browser type graph.
 */

// ---------------------------------------------------------------------------
// Literal unions
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = [
  'decision',
  'constraint',
  'gotcha',
  'pattern',
  'integration_note',
  'domain_rule',
  'outcome',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = [
  'active',
  'pending_revalidation',
  'superseded',
  'deprecated',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const DECISION_CRITERIA = [
  'specificity',
  'duplication',
  'contradiction',
  'grounding',
  'confidence',
  'security_second_layer',
  'stale_target',
] as const;
export type DecisionCriterion = (typeof DECISION_CRITERIA)[number];

export const VERDICTS = ['accepted', 'rejected', 'uncertain'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const QUARANTINE_REASON_CODES = [
  'secret_detected',
  'embedded_instructions',
  'duplicate_content',
  'judge_rejected',
  'human_rejected',
  'sanitize_failed',
] as const;
export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

export const QUARANTINE_CRITERIA = ['pipeline', 'judge', 'human_review'] as const;
export type QuarantineCriterion = (typeof QUARANTINE_CRITERIA)[number];

export const PROJECT_ROLES = ['project_admin', 'contributor', 'viewer', 'service_agent'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const OPS = ['add', 'amend', 'supersede', 'deprecate'] as const;
export type Op = (typeof OPS)[number];

export const CONFLICT_CODES = [
  'target_changed',
  'target_inactive',
  'duplicate_content',
  'duplicate_inactive',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

export type QueueFilter = 'all' | 'uncertain' | 'mandatory';

// ---------------------------------------------------------------------------
// Errors (C2/C5)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Identity (C2)
// ---------------------------------------------------------------------------

export interface MeDto {
  user: { id: string; email: string; displayName: string | null };
  /** role is a ProjectRole string; validated by the shell before use. */
  projects: Array<{ id: string; slug: string; name: string; role: string }>;
}

// ---------------------------------------------------------------------------
// Review queue (C2, HU-07)
// ---------------------------------------------------------------------------

export interface ReviewQueueItemDto {
  id: string;
  op: Op;
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
  reasonCode: QuarantineReasonCode | null;
  criterion: QuarantineCriterion | null;
  op: Op;
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
  /** Project admins only; absent for authors. */
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
// Memory lifecycle (C4) and direct management (C5)
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
  nextCursor: string | null;
  truncated: boolean;
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

export interface MemoryRevisionDto {
  revisionNo: number;
  op: Op;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
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
  author: string | null;
  approver: { name: string | null } | null;
  repo: { id: string; slug: string | null } | null;
  originBranch: string | null;
  originPr: number | null;
  createdAt: string;
  updatedAt: string;
  revalidateAt: string | null;
  retiredReason: string | null;
  revisions: MemoryRevisionDto[];
  revisionsTruncated: boolean;
}

export interface UnitRequest {
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  repoId?: string;
}

export type PreviewRequest =
  | ({ op: 'add' } & UnitRequest)
  | ({ op: 'amend'; targetMemoryId: string; expectedRevision: number } & UnitRequest);

export type CreateMemoryRequest = UnitRequest;
export type AmendMemoryRequest = UnitRequest & { expectedRevision: number };

export interface PreviewResponseDto {
  outcome: 'apply' | 'quarantine' | 'unavailable';
  withoutApproval: 'apply' | 'queue_uncertain' | 'queue_mandatory' | 'quarantine';
  pipeline: {
    blocked: boolean;
    reasonCode: 'secret_detected' | 'embedded_instructions' | 'sanitize_failed' | null;
    findings: { secrets?: string[]; injection?: string[]; pii?: string[] };
  };
  preview: { title: string; summary: string; body: string; fields: Record<string, unknown> } | null;
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
// Administration summary (C7)
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
