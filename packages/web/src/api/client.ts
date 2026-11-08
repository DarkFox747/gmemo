/**
 * Typed fetch client for /api/v1 (same origin, relative URLs).
 *
 * - `fetch` is injected (tests pass a fake). No Authorization header and no
 *   stored tokens: in development the user is selected with X-Dev-User, which
 *   the server ignores in production.
 * - Every path segment is encoded; queries drop undefined/empty values so the
 *   server's strict zod schemas never see stray keys.
 * - Errors become ApiError(kind). Server error strings are never shown; only a
 *   409/503 `code` is read from the body.
 */

import { MESSAGES } from '../lib/labels';
import {
  CONFLICT_CODES,
  type AdminSummaryDto,
  type AmendMemoryRequest,
  type ApproveResponseDto,
  type ConfirmResponseDto,
  type ConflictCode,
  type CreateMemoryRequest,
  type DirectWriteResponseDto,
  type MeDto,
  type MemoryDetailDto,
  type MemoryListDto,
  type MemoryStatus,
  type MemoryType,
  type PreviewRequest,
  type PreviewResponseDto,
  type QuarantineDetailDto,
  type QuarantineListDto,
  type QuarantineReasonCode,
  type QueueFilter,
  type RejectResponseDto,
  type RestoreResponseDto,
  type RetireByPrResponseDto,
  type RetireResponseDto,
  type ReviewItemDetailDto,
  type ReviewQueueListDto,
} from './types';

export type ApiErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'server'
  | 'network';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    readonly conflictCode?: ConflictCode,
  ) {
    super(kind);
    this.name = 'ApiError';
  }
}

export interface ApiClientDeps {
  fetchFn: typeof fetch;
  getDevUser: () => string | null;
}

export interface ApiClient {
  getMe(): Promise<MeDto>;
  listReviewQueue(
    p: string,
    q: { filter: QueueFilter; type?: MemoryType; limit?: number },
  ): Promise<ReviewQueueListDto>;
  getReviewItem(p: string, itemId: string): Promise<ReviewItemDetailDto>;
  approveReviewItem(
    p: string,
    itemId: string,
    b: { markRelatedSuperseded: boolean; targetRevision?: number },
  ): Promise<ApproveResponseDto>;
  rejectReviewItem(p: string, itemId: string, b: { reason: string }): Promise<RejectResponseDto>;
  listQuarantine(
    p: string,
    q: { reason?: QuarantineReasonCode; limit?: number },
  ): Promise<QuarantineListDto>;
  getQuarantineItem(p: string, id: string): Promise<QuarantineDetailDto>;
  restoreQuarantineItem(p: string, id: string): Promise<RestoreResponseDto>;
  listMemories(
    p: string,
    q: { status: MemoryStatus; type?: MemoryType; q?: string; cursor?: string; limit?: number },
  ): Promise<MemoryListDto>;
  getMemory(p: string, id: string): Promise<MemoryDetailDto>;
  previewMemory(p: string, b: PreviewRequest): Promise<PreviewResponseDto>;
  createMemory(p: string, b: CreateMemoryRequest): Promise<DirectWriteResponseDto>;
  amendMemory(p: string, id: string, b: AmendMemoryRequest): Promise<DirectWriteResponseDto>;
  confirmMemory(p: string, id: string): Promise<ConfirmResponseDto>;
  retireMemory(p: string, id: string, b: { reason: string }): Promise<RetireResponseDto>;
  retireByPr(p: string, b: { originPr: number; reason: string }): Promise<RetireByPrResponseDto>;
  getAdminSummary(p: string): Promise<AdminSummaryDto>;
}

type Query = Record<string, string | number | undefined>;

function buildQuery(q: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

const seg = encodeURIComponent;
const project = (p: string): string => `/api/v1/projects/${seg(p)}`;

function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid';
  return 'server';
}

/** Reads `code` from an error body; any parse failure just means "no code". */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const devUser = deps.getDevUser();
    if (devUser) headers['X-Dev-User'] = devUser;
    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await deps.fetchFn(url, init);
    } catch {
      throw new ApiError('network', null);
    }

    if (!res.ok) {
      if (res.status === 409) {
        const code = await errorCode(res);
        const known = CONFLICT_CODES.find((c) => c === code);
        throw new ApiError('conflict', 409, known);
      }
      if (res.status === 503 && (await errorCode(res)) === 'evaluation_unavailable') {
        throw new ApiError('unavailable', 503);
      }
      throw new ApiError(kindForStatus(res.status), res.status);
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError('server', res.status);
    }
  }

  return {
    getMe: () => request('GET', '/api/v1/me'),
    listReviewQueue: (p, q) =>
      request(
        'GET',
        `${project(p)}/review-queue${buildQuery({ filter: q.filter, type: q.type, limit: q.limit })}`,
      ),
    getReviewItem: (p, itemId) => request('GET', `${project(p)}/review-queue/${seg(itemId)}`),
    approveReviewItem: (p, itemId, b) => {
      const body: { markRelatedSuperseded: boolean; targetRevision?: number } = {
        markRelatedSuperseded: b.markRelatedSuperseded,
      };
      if (b.targetRevision !== undefined) body.targetRevision = b.targetRevision;
      return request('POST', `${project(p)}/review-queue/${seg(itemId)}/approve`, body);
    },
    rejectReviewItem: (p, itemId, b) =>
      request('POST', `${project(p)}/review-queue/${seg(itemId)}/reject`, { reason: b.reason }),
    listQuarantine: (p, q) =>
      request('GET', `${project(p)}/quarantine${buildQuery({ reason: q.reason, limit: q.limit })}`),
    getQuarantineItem: (p, id) => request('GET', `${project(p)}/quarantine/${seg(id)}`),
    restoreQuarantineItem: (p, id) =>
      request('POST', `${project(p)}/quarantine/${seg(id)}/restore`, {}),
    listMemories: (p, q) =>
      request(
        'GET',
        `${project(p)}/memories${buildQuery({
          status: q.status,
          type: q.type,
          q: q.q?.trim(),
          cursor: q.cursor,
          limit: q.limit,
        })}`,
      ),
    getMemory: (p, id) => request('GET', `${project(p)}/memories/${seg(id)}`),
    previewMemory: (p, b) => request('POST', `${project(p)}/memories/preview`, b),
    createMemory: (p, b) => request('POST', `${project(p)}/memories`, { ...b, confirm: true }),
    amendMemory: (p, id, b) =>
      request('PUT', `${project(p)}/memories/${seg(id)}`, { ...b, confirm: true }),
    confirmMemory: (p, id) => request('POST', `${project(p)}/memories/${seg(id)}/confirm`, {}),
    retireMemory: (p, id, b) =>
      request('POST', `${project(p)}/memories/${seg(id)}/retire`, { reason: b.reason }),
    retireByPr: (p, b) =>
      request('POST', `${project(p)}/memories/retire-by-pr`, {
        originPr: b.originPr,
        reason: b.reason,
      }),
    getAdminSummary: (p) => request('GET', `${project(p)}/admin-summary`),
  };
}

/** User-facing Spanish message; never echoes server text. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return MESSAGES.errors.unknown;
  if (err.kind === 'conflict') {
    return err.conflictCode ? MESSAGES.conflict[err.conflictCode] : MESSAGES.errors.conflict;
  }
  if (err.kind === 'unavailable') return MESSAGES.unavailable;
  return MESSAGES.errors[err.kind];
}
