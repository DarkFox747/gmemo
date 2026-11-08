/**
 * GET /api/v1/projects/:projectId/search — search explorer "Buscar como agente" (C13).
 *
 * project_admin only (every other caller: opaque 404 before validation, no
 * audit). Strict query (400 without echo). Ranks with rankActiveMemories — the
 * same function as MCP recall — so the parity cases compare the route with
 * recallHandler on the same fixture. Audited as memories.search with the
 * recall-normalised query hash only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { recallHandler } from '../../../src/mcp/tools/recall.js';
import { decodeHandle } from '../../../src/mcp/handle.js';
import { sha256Hex } from '../../../src/security/hash.js';
import { logger } from '../../../src/observability/logger.js';
import type { Embedder } from '../../../src/embedder/embedder.js';
import type { HandlerDeps, RequestContext } from '../../../src/mcp/context.js';
import type { MemoryType } from '../../../src/contracts/memory.js';
import type { SearchResponseDto } from '../../../src/http/api/types.js';
import type { StagingRepository } from '../../../src/db/stagingRepository.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../../memory/fakes.js';
import { PROJECT_A, PROJECT_B, RANDOM_PROJECT, USERS, bearer, makeApiTestApp } from './helpers.js';

const REPO_R = 'aaaaaaaa-0000-4000-8000-000000000001';
const REPO_S = 'aaaaaaaa-0000-4000-8000-000000000002';
const REPO_FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001';
const UPDATED_AT = new Date('2025-06-01T00:00:00Z');
const QUERY_VEC = [1, 0, 0];

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(1);
const B = id(2);
const C = id(3);
const F = id(4);

function mem(over: Partial<FakeMemory> & Pick<FakeMemory, 'id'>): FakeMemory {
  return {
    projectId: PROJECT_A,
    repoId: REPO_S,
    type: 'decision',
    title: 'title',
    summary: 'summary',
    body: 'body',
    updatedAt: UPDATED_AT,
    ...over,
  };
}

// A: lexical 1st (2 hits) + semantic 3rd; B: lexical 2nd only; C: semantic 1st
// only; F: semantic 2nd only (ties B on score, loses on id).
const SCENARIO: FakeMemory[] = [
  mem({ id: A, title: 'retry policy', embedding: [0.6, 0.8, 0] }),
  mem({ id: B, title: 'retry', embedding: null }),
  mem({ id: C, embedding: [1, 0, 0] }),
  mem({ id: F, embedding: [0.9, 0.43589, 0] }),
];

const fixedEmbedder: Embedder = { embed: () => Promise.resolve(QUERY_VEC) };

/** Project repo lookup: R and S belong to PROJECT_A, FOREIGN to PROJECT_B. */
function repoLookup() {
  const repos = new Map([
    [PROJECT_A, [REPO_R, REPO_S]],
    [PROJECT_B, [REPO_FOREIGN]],
  ]);
  const calls: Array<[string, string | null]> = [];
  return {
    calls,
    findProjectRepoId: async (projectId: string, repoId: string | null) => {
      calls.push([projectId, repoId]);
      const own = repos.get(projectId) ?? [];
      if (repoId === null) return own[0] ?? null;
      return own.includes(repoId) ? repoId : null;
    },
  };
}

function kit(memories: FakeMemory[] = SCENARIO, embedder: Embedder = fixedEmbedder) {
  const memoryRepository = new InMemoryMemoryRepository(memories);
  const lookup = repoLookup();
  const k = makeApiTestApp({ memoryRepository, embedder, memoryAdminRepository: lookup });
  return { ...k, memoryRepository, lookup };
}

const url = (qs: string, p: string = PROJECT_A): string => `/api/v1/projects/${p}/search?${qs}`;

async function search(k: ReturnType<typeof kit>, qs: string) {
  return request(k.app).get(url(qs)).set('Authorization', bearer(USERS.adminA));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /search — gates', () => {
  it('401 without credentials', async () => {
    const res = await request(kit().app).get(url('q=retry'));
    expect(res.status).toBe(401);
  });

  it.each([
    ['contributor', USERS.contributorA, PROJECT_A],
    ['viewer', USERS.viewerA, PROJECT_A],
    ['service agent', USERS.serviceA, PROJECT_A],
    ['admin of another project', USERS.adminB, PROJECT_A],
    ['admin on an unknown project', USERS.adminA, RANDOM_PROJECT],
  ])('%s → uniform 404 before validation, no audit', async (_label, user, project) => {
    const k = kit();
    for (const qs of ['q=retry', 'limit=99&bogus=1']) {
      const res = await request(k.app).get(url(qs, project)).set('Authorization', bearer(user));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
    expect(k.authRepo.accessLogEntries).toHaveLength(0);
    expect(k.lookup.calls).toHaveLength(0);
  });

  it('project_admin → 200 with no-store', async () => {
    const res = await search(kit(), 'q=retry');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /search — validation', () => {
  it.each([
    ['missing q', 'limit=5'],
    ['whitespace-only q', 'q=%20%20%20'],
    ['q of 201 chars', `q=${'a'.repeat(201)}`],
    ['limit 0', 'q=retry&limit=0'],
    ['limit 9', 'q=retry&limit=9'],
    ['non-numeric limit', 'q=retry&limit=abc'],
    ['exponent limit', 'q=retry&limit=1e0'],
    ['empty types', 'q=retry&types='],
    ['unknown type', 'q=retry&types=decision,bogus'],
    ['repeated q', 'q=a&q=b'],
    ['repeated types', 'q=a&types=decision&types=gotcha'],
    ['unknown param', 'q=retry&scope=repo'],
    ['malformed repoId', 'q=retry&repoId=not-a-uuid'],
  ])('%s → 400 opaque, no audit', async (_label, qs) => {
    const k = kit();
    const res = await search(k, qs);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
    expect(k.authRepo.accessLogEntries).toHaveLength(0);
  });

  it('accepts q of exactly 200 chars and a deduplicated types CSV', async () => {
    const k = kit();
    expect((await search(k, `q=${'a'.repeat(200)}`)).status).toBe(200);
    expect((await search(k, 'q=retry&types=decision,decision,gotcha')).status).toBe(200);
  });

  it('a well-formed repoId of another project → uniform 404, no audit', async () => {
    const k = kit();
    const res = await search(k, `q=retry&repoId=${REPO_FOREIGN}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(k.lookup.calls).toEqual([[PROJECT_A, REPO_FOREIGN]]);
    expect(k.authRepo.accessLogEntries).toHaveLength(0);
  });
});

describe('GET /search — behaviour', () => {
  it('spec scenario: A, C, B with lexical/semantic ranks and RRF scores', async () => {
    const k = kit();
    const res = await search(k, 'q=retry%20policy');
    const body = res.body as SearchResponseDto;

    expect(body.semantic).toBe('ok');
    expect(body.repoId).toBeNull();
    expect(body.totalCandidates).toBe(4);
    expect(body.items.map((i) => i.id)).toEqual([A, C, B, F]);
    const [a, c, b] = body.items;
    expect(a).toMatchObject({ position: 1, lexicalRank: 1, semanticRank: 3 });
    expect(c).toMatchObject({ position: 2, lexicalRank: null, semanticRank: 1 });
    expect(b).toMatchObject({ position: 3, lexicalRank: 2, semanticRank: null });
    expect(a!.score).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(c!.score).toBeCloseTo(1 / 61, 12);
    expect(b!.score).toBeCloseTo(1 / 62, 12);
    // No repo given: the lookup is never called (it would fall back to the first repo).
    expect(k.lookup.calls).toHaveLength(0);
  });

  it('DTO carries identity and metadata only (no body, no fields)', async () => {
    const res = await search(kit(), 'q=retry%20policy&limit=1');
    expect(res.body.items).toEqual([
      {
        position: 1,
        id: A,
        type: 'decision',
        title: 'retry policy',
        summary: 'summary',
        repoId: REPO_S,
        version: 1,
        updatedAt: UPDATED_AT.toISOString(),
        score: expect.any(Number),
        lexicalRank: 1,
        semanticRank: 3,
      },
    ]);
  });

  it('default limit 5, max 8; totalCandidates is the fused list size', async () => {
    const twenty = Array.from({ length: 20 }, (_, n) =>
      mem({ id: id(100 + n), title: `retry ${n}`, embedding: null }),
    );
    const k = kit(twenty);
    const def = (await search(k, 'q=retry')).body as SearchResponseDto;
    const max = (await search(k, 'q=retry&limit=8')).body as SearchResponseDto;
    expect(def.items).toHaveLength(5);
    expect(max.items).toHaveLength(8);
    expect(def.totalCandidates).toBe(20);
    expect(max.totalCandidates).toBe(20);
  });

  it('superseded, deprecated and pending-revalidation memories are never returned', async () => {
    const inactive = (['superseded', 'deprecated', 'pending_revalidation'] as const).map((s, n) =>
      mem({ id: id(200 + n), title: 'retry policy', status: s, embedding: [1, 0, 0] }),
    );
    const k = kit([...SCENARIO, ...inactive]);
    const body = (await search(k, 'q=retry%20policy&limit=8')).body as SearchResponseDto;
    const ids = body.items.map((i) => i.id);
    for (const m of inactive) expect(ids).not.toContain(m.id);
    expect(body.totalCandidates).toBe(4);
  });

  it('types filter narrows the candidates', async () => {
    const k = kit([...SCENARIO, mem({ id: id(300), type: 'gotcha', title: 'retry gotcha' })]);
    const body = (await search(k, 'q=retry&types=gotcha')).body as SearchResponseDto;
    expect(body.items.map((i) => i.id)).toEqual([id(300)]);
  });

  it('repoId boost: that repo first, fused order kept inside each group, echoed back', async () => {
    const k = kit([
      ...SCENARIO,
      mem({ id: id(400), repoId: REPO_R, title: 'retry', embedding: null }),
    ]);
    const body = (await search(k, `q=retry%20policy&limit=8&repoId=${REPO_R}`))
      .body as SearchResponseDto;
    expect(body.repoId).toBe(REPO_R);
    expect(body.items.map((i) => i.id)).toEqual([id(400), A, C, F, B]); // B drops to lexical 3rd
    expect(body.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('embedder down → 200 lexical only, semantic unavailable, one warning without the query', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const down: Embedder = { embed: () => Promise.reject(new Error('connection refused')) };
    const k = kit(SCENARIO, down);
    const res = await search(k, 'q=retry%20policy');
    expect(res.status).toBe(200);
    const body = res.body as SearchResponseDto;
    expect(body.semantic).toBe('unavailable');
    expect(body.items.map((i) => i.id)).toEqual([A, B]);
    expect(body.items.every((i) => i.semanticRank === null)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain('retry');
  });

  it('audits memories.search with the recall-normalised hash only (no query, no repo id)', async () => {
    const k = kit();
    const res = await search(k, `q=${encodeURIComponent('  Retry Policy ')}&repoId=${REPO_S}`);
    expect(res.status).toBe(200);
    expect(k.authRepo.accessLogEntries).toHaveLength(1);
    const row = k.authRepo.accessLogEntries[0]!;
    expect(row).toMatchObject({
      action: 'read',
      projectId: PROJECT_A,
      queryHash: sha256Hex('retry policy'),
    });
    expect(row.detail).toEqual({
      api: 'memories.search',
      resultCount: res.body.items.length,
      userId: USERS.adminA.userId,
    });
    const serialized = JSON.stringify(row).toLowerCase();
    expect(serialized).not.toContain('retry');
    expect(serialized).not.toContain(REPO_S);
  });
});

describe('GET /search — parity with recall', () => {
  // Two repos; equally relevant memories so repo priority decides the order.
  const PARITY: FakeMemory[] = [
    ...SCENARIO,
    mem({ id: id(500), repoId: REPO_R, title: 'retry policy', embedding: [0.8, 0.6, 0] }),
    mem({ id: id(501), repoId: REPO_R, title: 'policy', type: 'gotcha', embedding: null }),
    mem({ id: id(502), repoId: REPO_S, title: 'retry policy', type: 'gotcha', embedding: null }),
    ...Array.from({ length: 6 }, (_, n) =>
      mem({ id: id(600 + n), repoId: n % 2 ? REPO_R : REPO_S, title: `retry ${n}` }),
    ),
  ];

  const emptyStaging: StagingRepository = {
    findOrCreateOpenSession: () => Promise.resolve('s'),
    insertStagingItem: () =>
      Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
    listStagingItems: () => Promise.resolve([]),
    discardStagingItem: () => Promise.resolve(false),
  };

  async function recallIds(
    repo: InMemoryMemoryRepository,
    limit: number,
    types?: MemoryType[],
  ): Promise<string[]> {
    const ctx: RequestContext = {
      tenant: { projectId: PROJECT_A, repoId: REPO_R, branch: 'feature/x' },
      actor: { actorId: 'agent', roles: ['contributor'] },
    };
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: emptyStaging,
      embedder: fixedEmbedder,
      notifier: { notify: () => Promise.resolve() },
    };
    const res = await recallHandler(
      { query: 'retry policy', scope: 'project', limit, types },
      ctx,
      deps,
    );
    return res.results.map((r) => decodeHandle(r.handle).memoryId);
  }

  it.each([
    [5, undefined],
    [8, undefined],
    [8, ['decision'] as MemoryType[]],
    [5, ['gotcha', 'decision'] as MemoryType[]],
  ])('limit %i, types %j: explorer ids equal recall ids in order', async (limit, types) => {
    const k = kit(PARITY);
    const qs =
      `q=retry%20policy&limit=${limit}&repoId=${REPO_R}` +
      (types ? `&types=${types.join(',')}` : '');
    const body = (await search(k, qs)).body as SearchResponseDto;
    const expected = await recallIds(k.memoryRepository, limit, types);
    expect(expected.length).toBeGreaterThan(0);
    expect(body.items.map((i) => i.id)).toEqual(expected);
  });
});
