import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, errorMessage } from './client';
import type { ApiClient } from './client';
import { MESSAGES } from '../lib/labels';
import type { MeDto, ReviewQueueListDto } from './types';

const P = '00000000-0000-0000-0000-000000000010';
const ID = '00000000-0000-0000-0000-000000000301';

interface Call {
  url: string;
  init: RequestInit;
}

function headersOf(c: Call): Headers {
  return new Headers(c.init.headers);
}

/** Fake fetch: records each call and replies with the scripted status/body. */
function fakeClient(
  reply: { status?: number; body?: unknown; raw?: string; reject?: boolean } = {},
  devUser: string | null = 'tl@demo.local',
): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (reply.reject) throw new TypeError('Failed to fetch');
    const text = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { api: createApiClient({ fetchFn, getDevUser: () => devUser }), calls };
}

const ME: MeDto = {
  user: { id: 'u1', email: 'tl@demo.local', displayName: 'Tech Lead (demo)' },
  projects: [{ id: P, slug: 'portal-clientes', name: 'Portal de Clientes', role: 'project_admin' }],
};

const QUEUE: ReviewQueueListDto = {
  items: [
    {
      id: ID,
      op: 'add',
      type: 'decision',
      title: 'Use a queue',
      judgeState: 'uncertain',
      criterion: 'contradiction',
      confidence: 0.62,
      mandatoryReview: true,
      originBranch: 'feature/notif-async',
      originPr: 184,
      author: 'Developer (demo)',
      createdAt: '2026-03-12T10:42:00.000Z',
    },
  ],
  counters: { pending: 4, uncertain: 2, mandatory: 2, resolvedLast7Days: 17 },
  truncated: false,
};

describe('requests', () => {
  it('getMe: GET /api/v1/me, no-store, Accept JSON, X-Dev-User, never Authorization', async () => {
    const { api, calls } = fakeClient({ body: ME });
    await expect(api.getMe()).resolves.toEqual(ME);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/v1/me');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.cache).toBe('no-store');
    const h = headersOf(calls[0]!);
    expect(h.get('Accept')).toBe('application/json');
    expect(h.get('X-Dev-User')).toBe('tl@demo.local');
    expect(h.has('Authorization')).toBe(false);
    expect(h.has('Content-Type')).toBe(false);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('omits X-Dev-User when no dev user is selected', async () => {
    const { api, calls } = fakeClient({ body: ME }, null);
    await api.getMe();
    expect(headersOf(calls[0]!).has('X-Dev-User')).toBe(false);
  });

  it('listReviewQueue builds the query and drops undefined values', async () => {
    const { api, calls } = fakeClient({ body: QUEUE });
    await expect(
      api.listReviewQueue(P, { filter: 'uncertain', type: 'decision' }),
    ).resolves.toEqual(QUEUE);
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/review-queue?filter=uncertain&type=decision`);
    await api.listReviewQueue(P, { filter: 'all', limit: 1 });
    expect(calls[1]!.url).toBe(`/api/v1/projects/${P}/review-queue?filter=all&limit=1`);
  });

  it('encodes every path segment', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.getReviewItem('a/b', 'c?d');
    expect(calls[0]!.url).toBe('/api/v1/projects/a%2Fb/review-queue/c%3Fd');
  });

  it('approve: JSON body, targetRevision omitted when undefined', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.approveReviewItem(P, ID, { markRelatedSuperseded: true });
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/review-queue/${ID}/approve`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!).get('Content-Type')).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"markRelatedSuperseded":true}');
    await api.approveReviewItem(P, ID, { markRelatedSuperseded: false, targetRevision: 3 });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      markRelatedSuperseded: false,
      targetRevision: 3,
    });
  });

  it('reject sends the reason', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.rejectReviewItem(P, ID, { reason: 'Not specific' });
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/review-queue/${ID}/reject`);
    expect(calls[0]!.init.body).toBe('{"reason":"Not specific"}');
  });

  it('quarantine list/detail/restore', async () => {
    const { api, calls } = fakeClient({ body: { items: [], truncated: false } });
    await api.listQuarantine(P, { reason: 'secret_detected' });
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/quarantine?reason=secret_detected`);
    await api.listQuarantine(P, {});
    expect(calls[1]!.url).toBe(`/api/v1/projects/${P}/quarantine`);
    await api.getQuarantineItem(P, ID);
    expect(calls[2]!.url).toBe(`/api/v1/projects/${P}/quarantine/${ID}`);
    await api.restoreQuarantineItem(P, ID);
    expect(calls[3]!.url).toBe(`/api/v1/projects/${P}/quarantine/${ID}/restore`);
    expect(calls[3]!.init.method).toBe('POST');
    expect(calls[3]!.init.body).toBe('{}');
    expect(headersOf(calls[3]!).get('Content-Type')).toBe('application/json');
  });

  it('memories: list query (empty q dropped), detail, preview, create, amend', async () => {
    const { api, calls } = fakeClient({ body: { items: [], nextCursor: null, truncated: false } });
    await api.listMemories(P, {
      status: 'pending_revalidation',
      type: 'gotcha',
      q: '',
      cursor: 'abc',
    });
    expect(calls[0]!.url).toBe(
      `/api/v1/projects/${P}/memories?status=pending_revalidation&type=gotcha&cursor=abc`,
    );
    await api.listMemories(P, { status: 'active', q: 'cola pagos' });
    expect(calls[1]!.url).toBe(`/api/v1/projects/${P}/memories?status=active&q=cola+pagos`);
    await api.getMemory(P, ID);
    expect(calls[2]!.url).toBe(`/api/v1/projects/${P}/memories/${ID}`);

    const unit = { type: 'gotcha' as const, title: 't', summary: 's', body: 'b', fields: {} };
    await api.previewMemory(P, { op: 'add', ...unit });
    expect(calls[3]!.url).toBe(`/api/v1/projects/${P}/memories/preview`);
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ op: 'add', ...unit });

    await api.createMemory(P, unit);
    expect(calls[4]!.url).toBe(`/api/v1/projects/${P}/memories`);
    expect(calls[4]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ ...unit, confirm: true });

    await api.amendMemory(P, ID, { ...unit, expectedRevision: 2 });
    expect(calls[5]!.url).toBe(`/api/v1/projects/${P}/memories/${ID}`);
    expect(calls[5]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({
      ...unit,
      expectedRevision: 2,
      confirm: true,
    });
  });

  it('lifecycle: confirm {} / retire reason / retire-by-pr', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.confirmMemory(P, ID);
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/memories/${ID}/confirm`);
    expect(calls[0]!.init.body).toBe('{}');
    await api.retireMemory(P, ID, { reason: 'Obsolete now' });
    expect(calls[1]!.url).toBe(`/api/v1/projects/${P}/memories/${ID}/retire`);
    expect(calls[1]!.init.body).toBe('{"reason":"Obsolete now"}');
    await api.retireByPr(P, { originPr: 170, reason: 'Reverted' });
    expect(calls[2]!.url).toBe(`/api/v1/projects/${P}/memories/retire-by-pr`);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ originPr: 170, reason: 'Reverted' });
  });

  it('admin summary', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.getAdminSummary(P);
    expect(calls[0]!.url).toBe(`/api/v1/projects/${P}/admin-summary`);
  });

  it('insights: dashboard, activity (empty values dropped), staging; encoded project', async () => {
    const { api, calls } = fakeClient({ body: {} });
    await api.getDashboard(P);
    await api.listActivity(P, {});
    await api.listActivity(P, { category: 'review', cursor: '119', limit: 50 });
    await api.listActivity(P, { cursor: '' });
    await api.listStaging(P, { status: 'closed' });
    await api.listStaging('a/b', { status: 'open', limit: 5 });
    expect(calls.map((c) => c.url)).toEqual([
      `/api/v1/projects/${P}/dashboard`,
      `/api/v1/projects/${P}/activity`,
      `/api/v1/projects/${P}/activity?category=review&cursor=119&limit=50`,
      `/api/v1/projects/${P}/activity`,
      `/api/v1/projects/${P}/staging?status=closed`,
      '/api/v1/projects/a%2Fb/staging?status=open&limit=5',
    ]);
    for (const c of calls) expect(c.init.method).toBe('GET');
  });

  it('search: q trimmed, types joined with ",", empty values omitted', async () => {
    const { api, calls } = fakeClient({ body: {} });
    const R = '00000000-0000-0000-0000-000000000501';
    await api.search(P, { q: '  retry policy ' });
    await api.search(P, { q: 'retry', types: [], limit: 5 });
    await api.search(P, { q: 'retry', types: ['decision', 'gotcha'], limit: 8, repoId: R });
    expect(calls.map((c) => c.url)).toEqual([
      `/api/v1/projects/${P}/search?q=retry+policy`,
      `/api/v1/projects/${P}/search?q=retry&limit=5`,
      `/api/v1/projects/${P}/search?q=retry&types=decision%2Cgotcha&limit=8&repoId=${R}`,
    ]);
    for (const c of calls) expect(c.init.method).toBe('GET');
  });
});

describe('errors', () => {
  async function failure(reply: Parameters<typeof fakeClient>[0]): Promise<ApiError> {
    const { api } = fakeClient(reply);
    try {
      await api.getMe();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      return err as ApiError;
    }
    throw new Error('expected a rejection');
  }

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [400, 'invalid'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
  ])('%i → %s', async (status, kind) => {
    const err = await failure({ status, body: { error: 'Something' } });
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('409 with a known code → conflict + code', async () => {
    const err = await failure({ status: 409, body: { error: 'Conflict', code: 'target_changed' } });
    expect(err.kind).toBe('conflict');
    expect(err.conflictCode).toBe('target_changed');
  });

  it('409 with an unknown code → conflict without code', async () => {
    const err = await failure({ status: 409, body: { error: 'Conflict', code: 'weird' } });
    expect(err.kind).toBe('conflict');
    expect(err.conflictCode).toBeUndefined();
  });

  it('503 evaluation_unavailable → unavailable', async () => {
    const err = await failure({
      status: 503,
      body: { error: 'Service unavailable', code: 'evaluation_unavailable' },
    });
    expect(err.kind).toBe('unavailable');
  });

  it('fetch rejection → network with status null', async () => {
    const err = await failure({ reject: true });
    expect(err.kind).toBe('network');
    expect(err.status).toBeNull();
  });

  it('2xx with a non-JSON body → server', async () => {
    const err = await failure({ status: 200, raw: '<html>oops</html>' });
    expect(err.kind).toBe('server');
  });

  it('errorMessage: Spanish text per kind and code, never the server string', () => {
    expect(errorMessage(new ApiError('unauthorized', 401))).toBe(MESSAGES.errors.unauthorized);
    expect(errorMessage(new ApiError('not_found', 404))).toBe(MESSAGES.errors.not_found);
    expect(errorMessage(new ApiError('invalid', 400))).toBe(MESSAGES.errors.invalid);
    expect(errorMessage(new ApiError('rate_limited', 429))).toBe(MESSAGES.errors.rate_limited);
    expect(errorMessage(new ApiError('server', 500))).toBe(MESSAGES.errors.server);
    expect(errorMessage(new ApiError('network', null))).toBe(MESSAGES.errors.network);
    expect(errorMessage(new ApiError('unavailable', 503))).toBe(MESSAGES.unavailable);
    expect(errorMessage(new ApiError('conflict', 409))).toBe(MESSAGES.errors.conflict);
    for (const code of [
      'target_changed',
      'target_inactive',
      'duplicate_content',
      'duplicate_inactive',
    ] as const) {
      expect(errorMessage(new ApiError('conflict', 409, code))).toBe(MESSAGES.conflict[code]);
    }
    expect(errorMessage(new Error('Internal server error'))).toBe(MESSAGES.errors.unknown);
    for (const m of Object.values(MESSAGES.errors)) expect(m).not.toMatch(/Internal|Not found/);
  });
});
