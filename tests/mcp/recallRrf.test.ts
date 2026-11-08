/**
 * tests/mcp/recallRrf.test.ts
 *
 * Recall handler — hybrid search by Reciprocal Rank Fusion (HU-08.1, HU-08.3,
 * HU-08.4). Deterministic: known lexical rankings (term hits, same age) and
 * injected embedding vectors on the in-memory fake repository.
 *
 * Covered: spec scenario A/C/B order, limit default/max, fail-soft semantic side
 * (embedder error AND semantic query error), repo priority, offset pagination,
 * staged drafts, candidate query parameters.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { recallInputShape } from '../../src/mcp/tools/schemas.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps, TenantContext } from '../../src/mcp/context.js';
import type { RecallRequest } from '../../src/contracts/tools.js';
import type { StagingRepository, StagingItemRow } from '../../src/db/stagingRepository.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type {
  LexicalCandidateParams,
  MemoryRow,
  RecallCandidateFilters,
} from '../../src/db/memoryRepository.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { decodeHandle } from '../../src/mcp/handle.js';
import { encodeOffsetCursor } from '../../src/search/rrf.js';
import { logger } from '../../src/observability/logger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-rrf';
const REPO_ID = 'repo-mine';
const OTHER_REPO_ID = 'repo-other';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'feat/rrf' },
  actor: { actorId: 'tester', roles: ['viewer'] },
};

const UPDATED_AT = new Date('2025-06-01T00:00:00Z');

/** Query embedding; memories are placed at known angles from it. */
const QUERY_VEC = [1, 0, 0];

const id = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

function mem(over: Partial<FakeMemory> & Pick<FakeMemory, 'id'>): FakeMemory {
  return {
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    type: 'decision',
    title: 'title',
    summary: 'summary',
    body: 'body',
    updatedAt: UPDATED_AT,
    ...over,
  };
}

function handleIds(results: { handle: string }[]): string[] {
  return results.map((r) => decodeHandle(r.handle).memoryId);
}

const fixedEmbedder = (vec: number[]): Embedder => ({ embed: () => Promise.resolve(vec) });

function makeStagingRepo(items: StagingItemRow[] = []): StagingRepository {
  return {
    findOrCreateOpenSession: () => Promise.resolve('test-session'),
    insertStagingItem: () =>
      Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
    listStagingItems: () => Promise.resolve(items),
    discardStagingItem: () => Promise.resolve(false),
  };
}

function makeDeps(
  repo: InMemoryMemoryRepository,
  opts: { embedder?: Embedder; staged?: StagingItemRow[] } = {},
): HandlerDeps {
  return {
    memoryRepository: repo,
    stagingRepository: makeStagingRepo(opts.staged),
    embedder: opts.embedder ?? fixedEmbedder(QUERY_VEC),
    notifier: { notify: () => Promise.resolve() },
  };
}

function stagedItem(n: number): StagingItemRow {
  return {
    id: `staged-${n}`,
    op: 'add',
    type: 'decision',
    title: `Staged draft ${n}`,
    summary: 'Staged draft summary',
    body: 'Staged draft body',
    fields: {},
    content_hash: `hash-${n}`,
    target_memory_id: null,
    target_revision: null,
    judge_state: 'pending',
    mandatory_review: false,
    created_at: new Date('2025-12-01T00:00:00Z'),
    promoted_at: null,
    promoted_memory_id: null,
  };
}

/** Spy subclass recording the candidate-query parameters. */
class SpyRepo extends InMemoryMemoryRepository {
  lexicalCalls: { params: LexicalCandidateParams; limit: number }[] = [];
  semanticCalls: { filters: RecallCandidateFilters; excludeIds: string[]; k: number }[] = [];

  async recallLexicalCandidates(
    tenant: TenantContext,
    params: LexicalCandidateParams,
    limit: number,
  ): Promise<MemoryRow[]> {
    this.lexicalCalls.push({ params, limit });
    return super.recallLexicalCandidates(tenant, params, limit);
  }

  async recallSemantic(
    tenant: TenantContext,
    queryEmbedding: number[],
    filters: RecallCandidateFilters,
    excludeIds: string[],
    k: number,
  ): Promise<MemoryRow[]> {
    this.semanticCalls.push({ filters, excludeIds: [...excludeIds], k });
    return super.recallSemantic(tenant, queryEmbedding, filters, excludeIds, k);
  }
}

/**
 * Spec scenario fixtures. Query "alpha beta":
 *   lexical (term hits, equal age):  A = 2 hits (1st), B = 1 hit (2nd), C = 0 hits (absent)
 *   semantic (cosine to QUERY_VEC):  C (1st), X (2nd, no lexical hit), A (3rd), B (no embedding)
 * Fused: A = 1/61 + 1/63, C = 1/61, B = 1/62, X = 1/62 (X after B on the id tie).
 */
const A = id(0xa);
const B = id(0xb);
const C = id(0xc);
const X = id(0xd);

const SCENARIO: FakeMemory[] = [
  mem({ id: A, title: 'alpha beta', embedding: [0.6, 0.8, 0] }),
  mem({ id: B, title: 'alpha', embedding: null }),
  mem({ id: C, title: 'gamma', embedding: [1, 0, 0] }),
  mem({ id: X, title: 'delta', embedding: [0.9, Math.sqrt(1 - 0.81), 0] }),
];

const SCENARIO_QUERY: RecallRequest = { query: 'alpha beta', scope: 'project' };

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// HU-08.1 — fusion
// ---------------------------------------------------------------------------

describe('recall RRF — fusion order (HU-08.1)', () => {
  it('orders A (lex 1st, sem 3rd), C (sem 1st), B (lex 2nd) by fused score', async () => {
    const deps = makeDeps(new InMemoryMemoryRepository(SCENARIO));

    const res = await recallHandler(SCENARIO_QUERY, CTX, deps);

    expect(handleIds(res.results)).toEqual([A, C, B, X]);
    expect(res.results.every((r) => r.source === 'main')).toBe(true);
  });

  it('total_matches is the number of fused candidates and each memory appears once', async () => {
    const deps = makeDeps(new InMemoryMemoryRepository(SCENARIO));

    const res = await recallHandler(SCENARIO_QUERY, CTX, deps);

    expect(res.total_matches).toBe(4);
    expect(new Set(handleIds(res.results)).size).toBe(res.results.length);
    expect(res.cursor).toBeNull();
  });

  it('requests 50 candidates from each ranking, with no exclusions', async () => {
    const repo = new SpyRepo(SCENARIO);

    await recallHandler({ ...SCENARIO_QUERY, types: ['decision'] }, CTX, makeDeps(repo));

    expect(repo.lexicalCalls).toHaveLength(1);
    expect(repo.lexicalCalls[0]!.limit).toBe(50);
    expect(repo.lexicalCalls[0]!.params).toEqual({
      query: 'alpha beta',
      scope: 'project',
      types: ['decision'],
    });
    expect(repo.semanticCalls).toHaveLength(1);
    expect(repo.semanticCalls[0]!.k).toBe(50);
    expect(repo.semanticCalls[0]!.excludeIds).toEqual([]);
    expect(repo.semanticCalls[0]!.filters).toEqual({ scope: 'project', types: ['decision'] });
  });

  it('applies type and scope filters to both rankings', async () => {
    const repo = new InMemoryMemoryRepository([
      mem({ id: A, title: 'alpha', type: 'gotcha', embedding: [1, 0, 0] }),
      mem({ id: B, title: 'alpha', type: 'decision', embedding: [1, 0, 0] }),
      mem({ id: C, title: 'alpha', repoId: OTHER_REPO_ID, embedding: [1, 0, 0] }),
    ]);

    const byType = await recallHandler({ query: 'alpha', types: ['gotcha'] }, CTX, makeDeps(repo));
    expect(handleIds(byType.results)).toEqual([A]);

    const byRepo = await recallHandler({ query: 'alpha', scope: 'repo' }, CTX, makeDeps(repo));
    expect(handleIds(byRepo.results).sort()).toEqual([A, B].sort());
  });
});

// ---------------------------------------------------------------------------
// Limit bounds
// ---------------------------------------------------------------------------

describe('recall RRF — limit bounds', () => {
  const twenty = Array.from({ length: 20 }, (_, i) =>
    mem({ id: id(0x100 + i), title: 'matching memory' }),
  );

  it('returns 5 results by default', async () => {
    const res = await recallHandler(
      { query: 'matching' },
      CTX,
      makeDeps(new InMemoryMemoryRepository(twenty)),
    );

    expect(res.results).toHaveLength(5);
    expect(res.total_matches).toBe(20);
    expect(res.cursor).not.toBeNull();
  });

  it('returns up to 8 results with limit 8', async () => {
    const res = await recallHandler(
      { query: 'matching', limit: 8 },
      CTX,
      makeDeps(new InMemoryMemoryRepository(twenty)),
    );

    expect(res.results).toHaveLength(8);
  });

  it('input schema rejects limit 9 and accepts an omitted limit', () => {
    const schema = z.object(recallInputShape);

    expect(schema.safeParse({ query: 'matching', limit: 9 }).success).toBe(false);
    expect(schema.safeParse({ query: 'matching', limit: 8 }).success).toBe(true);
    expect(schema.safeParse({ query: 'matching' }).success).toBe(true);
  });

  it('input schema rejects a cursor longer than 64 characters', () => {
    const schema = z.object(recallInputShape);

    expect(schema.safeParse({ query: 'matching', cursor: 'a'.repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ query: 'matching', cursor: 'a'.repeat(64) }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-soft semantic side
// ---------------------------------------------------------------------------

describe('recall RRF — fail-soft semantic side', () => {
  const QUERY_TEXT = 'alpha beta';

  it('embedder throws: returns the lexical ranking and logs exactly one warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    class EmbedderDownError extends Error {
      override name = 'EmbedderDownError';
    }
    const deps = makeDeps(new InMemoryMemoryRepository(SCENARIO), {
      embedder: { embed: () => Promise.reject(new EmbedderDownError('connection refused')) },
    });

    const res = await recallHandler(SCENARIO_QUERY, CTX, deps);

    // Lexical only: A (2 hits) then B (1 hit); C and X have no lexical hit.
    expect(handleIds(res.results)).toEqual([A, B]);
    expect(res.total_matches).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('EmbedderDownError');
    expect(message).not.toContain(QUERY_TEXT);
    expect(message).not.toContain('connection refused');
  });

  it('semantic query throws: returns the lexical ranking and logs one warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    class FailingSemanticRepo extends InMemoryMemoryRepository {
      async recallSemantic(): Promise<MemoryRow[]> {
        throw new Error('vector index unavailable');
      }
    }

    const res = await recallHandler(
      SCENARIO_QUERY,
      CTX,
      makeDeps(new FailingSemanticRepo(SCENARIO)),
    );

    expect(handleIds(res.results)).toEqual([A, B]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain('vector index unavailable');
  });

  it('a lexical failure is NOT swallowed (propagates)', async () => {
    class FailingLexicalRepo extends InMemoryMemoryRepository {
      async recallLexicalCandidates(): Promise<MemoryRow[]> {
        throw new Error('db down');
      }
    }

    await expect(
      recallHandler(SCENARIO_QUERY, CTX, makeDeps(new FailingLexicalRepo(SCENARIO))),
    ).rejects.toThrow('db down');
  });

  it('does not log anything on the happy path', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await recallHandler(SCENARIO_QUERY, CTX, makeDeps(new InMemoryMemoryRepository(SCENARIO)));

    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HU-08.3 — repo priority
// ---------------------------------------------------------------------------

describe('recall RRF — repo priority (HU-08.3)', () => {
  // Equally relevant; the other-repo memory has the higher id so, without repo
  // priority, it would rank first lexically.
  const MINE = id(1);
  const OTHER = id(2);
  const repo = () =>
    new InMemoryMemoryRepository([
      mem({ id: MINE, title: 'shared topic', repoId: REPO_ID }),
      mem({ id: OTHER, title: 'shared topic', repoId: OTHER_REPO_ID }),
    ]);

  it('project scope: the query repo memory comes first', async () => {
    const res = await recallHandler({ query: 'shared', scope: 'project' }, CTX, makeDeps(repo()));

    expect(handleIds(res.results)).toEqual([MINE, OTHER]);
  });

  it('scope defaults to project', async () => {
    const res = await recallHandler({ query: 'shared' }, CTX, makeDeps(repo()));

    expect(handleIds(res.results)).toEqual([MINE, OTHER]);
  });

  it('repo scope keeps the hard filter', async () => {
    const res = await recallHandler({ query: 'shared', scope: 'repo' }, CTX, makeDeps(repo()));

    expect(handleIds(res.results)).toEqual([MINE]);
    expect(res.total_matches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Offset pagination over the fused list
// ---------------------------------------------------------------------------

describe('recall RRF — offset pagination', () => {
  const twelve = Array.from({ length: 12 }, (_, i) =>
    mem({ id: id(0x200 + i), title: 'paged memory' }),
  );
  const deps = () => makeDeps(new InMemoryMemoryRepository(twelve));

  it('follows the cursor: pages of 5, 5 and 2 without duplicates; last cursor null', async () => {
    const page1 = await recallHandler({ query: 'paged', limit: 5 }, CTX, deps());
    expect(page1.results).toHaveLength(5);
    expect(page1.cursor).toBe(encodeOffsetCursor(5));

    const page2 = await recallHandler(
      { query: 'paged', limit: 5, cursor: page1.cursor! },
      CTX,
      deps(),
    );
    expect(page2.results).toHaveLength(5);
    expect(page2.cursor).toBe(encodeOffsetCursor(10));

    const page3 = await recallHandler(
      { query: 'paged', limit: 5, cursor: page2.cursor! },
      CTX,
      deps(),
    );
    expect(page3.results).toHaveLength(2);
    expect(page3.cursor).toBeNull();

    const all = [page1, page2, page3].flatMap((p) => handleIds(p.results));
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
    for (const p of [page1, page2, page3]) expect(p.total_matches).toBe(12);
  });

  it('cursor is null when the fused list fits in one page', async () => {
    const res = await recallHandler(
      { query: 'paged', limit: 8 },
      CTX,
      makeDeps(new InMemoryMemoryRepository(twelve.slice(0, 8))),
    );

    expect(res.cursor).toBeNull();
  });

  it('an offset past the end returns an empty page and a null cursor', async () => {
    const res = await recallHandler(
      { query: 'paged', cursor: encodeOffsetCursor(100) },
      CTX,
      deps(),
    );

    expect(res.results).toEqual([]);
    expect(res.cursor).toBeNull();
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['legacy keyset cursor', Buffer.from(`0.5:${id(1)}`, 'utf8').toString('base64url')],
  ])('an invalid cursor (%s) fails with INVALID_REFERENCE', async (_label, cursor) => {
    const err = await recallHandler({ query: 'paged', cursor }, CTX, deps()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.INVALID_REFERENCE);
  });

  it('an invalid cursor fails before any candidate query runs', async () => {
    const repo = new SpyRepo(twelve);

    await recallHandler({ query: 'paged', cursor: 'garbage!!' }, CTX, makeDeps(repo)).catch(
      () => undefined,
    );

    expect(repo.lexicalCalls).toHaveLength(0);
    expect(repo.semanticCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HU-08.4 — staged drafts
// ---------------------------------------------------------------------------

describe('recall RRF — staged drafts (HU-08.4)', () => {
  const repo = () => new InMemoryMemoryRepository(SCENARIO);

  it('prepends drafts on the first page, marked source:"staged"', async () => {
    const res = await recallHandler(
      SCENARIO_QUERY,
      CTX,
      makeDeps(repo(), { staged: [stagedItem(1), stagedItem(2)] }),
    );

    expect(res.results.map((r) => r.source)).toEqual([
      'staged',
      'staged',
      'main',
      'main',
      'main',
      'main',
    ]);
    // Drafts are not counted in total_matches.
    expect(res.total_matches).toBe(4);
  });

  it('caps drafts at limit', async () => {
    const staged = Array.from({ length: 10 }, (_, i) => stagedItem(i));

    const res = await recallHandler(
      { ...SCENARIO_QUERY, limit: 3 },
      CTX,
      makeDeps(repo(), { staged }),
    );

    expect(res.results.filter((r) => r.source === 'staged')).toHaveLength(3);
    expect(res.results.filter((r) => r.source === 'main')).toHaveLength(3);
  });

  it('cursor pages carry no drafts', async () => {
    const res = await recallHandler(
      { ...SCENARIO_QUERY, limit: 2, cursor: encodeOffsetCursor(2) },
      CTX,
      makeDeps(repo(), { staged: [stagedItem(1)] }),
    );

    expect(res.results.every((r) => r.source === 'main')).toBe(true);
    expect(handleIds(res.results)).toEqual([B, X]);
  });
});
