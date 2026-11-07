/**
 * tests/mcp/recallTwoPhase.test.ts
 *
 * T015 — Two-phase recall handler: BM25-first, semantic fallback.
 *
 * Uses SpyMemoryRepo (subclass of InMemoryMemoryRepository) to control what
 * recall() returns while still exercising recallSemantic() through the real
 * in-memory cosine-similarity implementation. A spy embedder closure tracks
 * call counts.
 *
 * Cases:
 *  (a) BM25 >= N  → embedder never called; recallSemantic never called;
 *                   results = staged + BM25 only; total_matches = BM25 count.
 *  (b) BM25 < N   → embedder called exactly once; recallSemantic called with
 *                   excludeIds = BM25 row ids and k = semanticFallbackK;
 *                   semantic rows appended AFTER BM25 rows; no id appears
 *                   twice; order: staged → BM25 → semantic;
 *                   total_matches = BM25 count (extras NOT counted).
 *  (c) embed fails → handler resolves (no throw); recallSemantic not called;
 *                   results = staged + BM25; total_matches = BM25 count.
 *  (d) cursor page → embedder not called; recallSemantic not called; no staged
 *                   records; results = BM25 only; cursor round-trips.
 */

import { describe, it, expect } from 'vitest';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps, TenantContext } from '../../src/mcp/context.js';
import type { RecallRequest } from '../../src/contracts/tools.js';
import type { StagingRepository, StagingItemRow } from '../../src/db/stagingRepository.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type {
  MemoryRow,
  RecallParams,
  RecallResult,
  RecallSemanticFilters,
} from '../../src/db/memoryRepository.js';
import { encodeRecallCursor } from '../../src/db/memoryRepository.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-two-phase-test';
const REPO_ID = 'repo-two-phase-test';

/** semanticFallbackMinResults — Phase 2 fires when totalMatches < N. */
const N = 5;
/** semanticFallbackK — number of nearest-neighbour rows requested. */
const K = 3;

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' },
  actor: { actorId: 'tester', roles: ['viewer'] },
};

const BASE_INPUT: RecallRequest = {
  query: 'two-phase recall test query',
  scope: 'project',
};

/**
 * A stable 1024-dim unit vector used as embedding for seeded semantic memories.
 * Points along the first dimension; L2-norm = 1.
 */
const UNIT_VEC: number[] = [1, ...new Array(1023).fill(0)];

// ---------------------------------------------------------------------------
// MemoryRow factory
// ---------------------------------------------------------------------------

function makeMemoryRow(id: string, title: string): MemoryRow {
  return {
    id,
    type: 'decision',
    title,
    summary: `summary for ${title}`,
    body: `body for ${title}`,
    fields: {},
    origin_branch: 'main',
    origin_pr: null,
    current_revision: 1,
    updated_at: new Date('2025-06-01T00:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// SpyMemoryRepo
//
// Subclasses InMemoryMemoryRepository to:
//  (1) Return a fixed RecallResult from recall() (handler-test concern, not
//      repo-logic concern — lets us control totalMatches independently of the
//      seeded FakeMemory list).
//  (2) Spy on recallSemantic() — record call count, last excludeIds, last k —
//      while delegating the actual cosine-similarity logic to super.
// ---------------------------------------------------------------------------

class SpyMemoryRepo extends InMemoryMemoryRepository {
  semanticCallCount = 0;
  lastExcludeIds: string[] = [];
  lastK = 0;

  private readonly _recallResult: RecallResult;

  constructor(fakeMemories: FakeMemory[], recallResult: RecallResult) {
    super(fakeMemories);
    this._recallResult = recallResult;
  }

  async recall(_tenant: TenantContext, _params: RecallParams): Promise<RecallResult> {
    return this._recallResult;
  }

  async recallSemantic(
    tenant: TenantContext,
    queryEmbedding: number[],
    filters: RecallSemanticFilters,
    excludeIds: string[],
    k: number,
  ): Promise<MemoryRow[]> {
    this.semanticCallCount++;
    this.lastExcludeIds = [...excludeIds];
    this.lastK = k;
    return super.recallSemantic(tenant, queryEmbedding, filters, excludeIds, k);
  }
}

// ---------------------------------------------------------------------------
// Spy embedder helpers
// ---------------------------------------------------------------------------

function makeSpyEmbedder(vec: number[]): { embedder: Embedder; callCount: () => number } {
  let count = 0;
  const embedder: Embedder = {
    embed: async (_text: string): Promise<number[]> => {
      count++;
      return vec;
    },
  };
  return { embedder, callCount: () => count };
}

function makeThrowingEmbedder(): { embedder: Embedder; callCount: () => number } {
  let count = 0;
  const embedder: Embedder = {
    embed: async (_text: string): Promise<number[]> => {
      count++;
      throw new Error('embed failed (intentional test stub)');
    },
  };
  return { embedder, callCount: () => count };
}

// ---------------------------------------------------------------------------
// Staging repository helpers
// ---------------------------------------------------------------------------

const STAGED_ITEM: StagingItemRow = {
  id: 'staged-00000000-0000-0000-0000-000000000001',
  op: 'add',
  type: 'decision',
  title: 'Staged draft title',
  summary: 'Staged draft summary',
  body: 'Staged draft body',
  fields: {},
  content_hash: 'deadbeef',
  target_memory_id: null,
  target_revision: null,
  judge_state: 'pending',
  created_at: new Date('2025-12-01T00:00:00Z'),
  promoted_at: null,
  promoted_memory_id: null,
};

function makeStagingRepo(items: StagingItemRow[] = []): StagingRepository {
  return {
    findOrCreateOpenSession: () => Promise.resolve('test-session'),
    insertStagingItem: () =>
      Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
    listStagingItems: () => Promise.resolve(items),
    discardStagingItem: () => Promise.resolve(false),
  };
}

// ---------------------------------------------------------------------------
// (a) BM25 >= N — Phase 2 is skipped entirely
// ---------------------------------------------------------------------------

describe('recallHandler two-phase — (a) BM25 >= N: Phase 2 skipped', () => {
  // totalMatches = N = 5.  Condition is totalMatches < N (5 < 5 === false).
  const BM25_ROWS = [
    makeMemoryRow('a0000000-0000-0000-0000-000000000001', 'BM25 Row A1'),
    makeMemoryRow('a0000000-0000-0000-0000-000000000002', 'BM25 Row A2'),
    makeMemoryRow('a0000000-0000-0000-0000-000000000003', 'BM25 Row A3'),
    makeMemoryRow('a0000000-0000-0000-0000-000000000004', 'BM25 Row A4'),
    makeMemoryRow('a0000000-0000-0000-0000-000000000005', 'BM25 Row A5'),
  ];

  const recallResult: RecallResult = {
    rows: BM25_ROWS,
    totalMatches: N, // = 5; NOT < N → Phase 2 skipped
    nextCursor: null,
  };

  it('embedder.embed is never called when totalMatches >= N', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder, callCount } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(callCount()).toBe(0);
  });

  it('recallSemantic is never called when totalMatches >= N', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(repo.semanticCallCount).toBe(0);
  });

  it('results order is staged → BM25, no semantic extras', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);
    const sources = response.results.map((r) => r.source);

    // First record is the staged draft, rest are main (BM25).
    expect(sources[0]).toBe('staged');
    expect(sources.slice(1).every((s) => s === 'main')).toBe(true);
    // Exactly staged + BM25; no semantic extras.
    expect(response.results.length).toBe(1 + BM25_ROWS.length);
  });

  it('total_matches equals the BM25 count', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    expect(response.total_matches).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// (b) BM25 < N — Phase 2 runs; semantic rows appended after BM25
// ---------------------------------------------------------------------------

describe('recallHandler two-phase — (b) BM25 < N: semantic rows appended', () => {
  /**
   * Two BM25 rows (no embedding in their FakeMemory seeds → excluded from
   * recallSemantic's `embedding IS NOT NULL` filter automatically).
   * totalMatches = 2 < N (5) → Phase 2 fires.
   */
  const BM25_ROWS = [
    makeMemoryRow('b0000000-0000-0000-0000-000000000001', 'BM25 Row B1'),
    makeMemoryRow('b0000000-0000-0000-0000-000000000002', 'BM25 Row B2'),
  ];

  const recallResult: RecallResult = {
    rows: BM25_ROWS,
    totalMatches: 2, // < N (5) → Phase 2 fires
    nextCursor: null,
  };

  /**
   * Two semantic-only FakeMemory entries: active, same project, have UNIT_VEC
   * embeddings, IDs not present in BM25_ROWS so excludeIds never covers them.
   * The InMemoryMemoryRepository.recallSemantic will find these and rank by
   * cosine similarity (UNIT_VEC dot UNIT_VEC = 1, the maximum).
   */
  const SEM_FAKES: FakeMemory[] = [
    {
      id: 'c0000000-0000-0000-0000-000000000011',
      projectId: PROJECT_ID,
      repoId: REPO_ID,
      type: 'decision',
      title: 'Semantic Row C1',
      summary: 'semantic summary c1',
      body: 'semantic body c1',
      status: 'active',
      embedding: UNIT_VEC,
      updatedAt: new Date('2025-06-01T00:00:00Z'),
    },
    {
      id: 'c0000000-0000-0000-0000-000000000022',
      projectId: PROJECT_ID,
      repoId: REPO_ID,
      type: 'decision',
      title: 'Semantic Row C2',
      summary: 'semantic summary c2',
      body: 'semantic body c2',
      status: 'active',
      embedding: UNIT_VEC,
      updatedAt: new Date('2025-06-01T00:00:00Z'),
    },
  ];

  it('embedder.embed is called exactly once', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder, callCount } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(callCount()).toBe(1);
  });

  it('recallSemantic is called with excludeIds = BM25 row ids', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(repo.semanticCallCount).toBe(1);
    const expectedIds = BM25_ROWS.map((r) => r.id).sort();
    expect([...repo.lastExcludeIds].sort()).toEqual(expectedIds);
  });

  it('recallSemantic is called with k = semanticFallbackK', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(repo.lastK).toBe(K);
  });

  it('semantic rows are appended AFTER BM25 rows', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    const titles = response.results.map((r) => r.title);
    const bm25Positions = BM25_ROWS.map((r) => titles.indexOf(r.title));
    const semPositions = SEM_FAKES.map((f) => titles.indexOf(f.title));

    // Every BM25 position must come before every semantic position.
    for (const bPos of bm25Positions) {
      expect(bPos).toBeGreaterThanOrEqual(0); // BM25 row present
      for (const sPos of semPositions) {
        expect(sPos).toBeGreaterThanOrEqual(0); // semantic row present
        expect(bPos).toBeLessThan(sPos);
      }
    }
  });

  it('full first-page order: staged → BM25 → semantic', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    // First record is staged.
    expect(response.results[0]?.source).toBe('staged');

    const titles = response.results.map((r) => r.title);
    const bm25Titles = BM25_ROWS.map((r) => r.title);
    const semTitles = SEM_FAKES.map((f) => f.title);

    const bm25MaxPos = Math.max(...bm25Titles.map((t) => titles.indexOf(t)));
    const semMinPos = Math.min(...semTitles.map((t) => titles.indexOf(t)));

    // All BM25 rows end before the first semantic row.
    expect(bm25MaxPos).toBeLessThan(semMinPos);
  });

  it('no handle appears twice (deduplicated)', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);
    const handles = response.results.map((r) => r.handle);

    expect(new Set(handles).size).toBe(handles.length);
  });

  it('total_matches equals BM25 count — semantic extras are NOT counted', async () => {
    const repo = new SpyMemoryRepo(SEM_FAKES, recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    expect(response.total_matches).toBe(recallResult.totalMatches); // 2

    // Sanity: verify semantic rows WERE appended so the assertion is meaningful.
    expect(response.results.length).toBeGreaterThan(BM25_ROWS.length);
  });
});

// ---------------------------------------------------------------------------
// (c) embed throws — BM25-only, no throw escapes, recallSemantic not called
// ---------------------------------------------------------------------------

describe('recallHandler two-phase — (c) embed throws: graceful BM25-only fallback', () => {
  const BM25_ROWS = [
    makeMemoryRow('d0000000-0000-0000-0000-000000000001', 'BM25 Row D1'),
  ];

  const recallResult: RecallResult = {
    rows: BM25_ROWS,
    totalMatches: 1, // < N (5) → would trigger Phase 2 if embed succeeded
    nextCursor: null,
  };

  it('handler resolves successfully even when embed rejects', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeThrowingEmbedder();
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await expect(recallHandler(BASE_INPUT, CTX, deps)).resolves.toBeDefined();
  });

  it('recallSemantic is never called when embed throws', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeThrowingEmbedder();
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler(BASE_INPUT, CTX, deps);

    expect(repo.semanticCallCount).toBe(0);
  });

  it('results contain staged + BM25 only (no semantic extras) when embed throws', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeThrowingEmbedder();
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    // Only STAGED_ITEM + 1 BM25 row; zero semantic rows.
    expect(response.results.length).toBe(1 + BM25_ROWS.length);
    expect(response.results[0]?.source).toBe('staged');
    expect(response.results[1]?.source).toBe('main');
  });

  it('total_matches still reflects BM25 count when embed throws', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeThrowingEmbedder();
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    expect(response.total_matches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) cursor page — Phase 2 never runs regardless of totalMatches
// ---------------------------------------------------------------------------

describe('recallHandler two-phase — (d) cursor page: Phase 2 always skipped', () => {
  // A well-formed cursor (rank=0.5, id is a valid-looking UUID).
  const A_VALID_CURSOR = encodeRecallCursor({
    rank: 0.5,
    id: 'e0000000-0000-0000-0000-000000000099',
  });

  const BM25_ROWS = [
    makeMemoryRow('e0000000-0000-0000-0000-000000000001', 'Cursor-Page BM25 Row'),
  ];

  const recallResult: RecallResult = {
    rows: BM25_ROWS,
    totalMatches: 1, // < N — would fire Phase 2 on a first page; MUST NOT on cursor page
    nextCursor: null,
  };

  it('embedder.embed is never called on a cursor (non-first) page', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder, callCount } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler({ ...BASE_INPUT, cursor: A_VALID_CURSOR }, CTX, deps);

    expect(callCount()).toBe(0);
  });

  it('recallSemantic is never called on a cursor page', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await recallHandler({ ...BASE_INPUT, cursor: A_VALID_CURSOR }, CTX, deps);

    expect(repo.semanticCallCount).toBe(0);
  });

  it('staged records are NOT included on cursor pages (keyset-only)', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler({ ...BASE_INPUT, cursor: A_VALID_CURSOR }, CTX, deps);

    expect(response.results.some((r) => r.source === 'staged')).toBe(false);
  });

  it('results contain only BM25 rows on a cursor page', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler({ ...BASE_INPUT, cursor: A_VALID_CURSOR }, CTX, deps);

    expect(response.results.length).toBe(BM25_ROWS.length);
    expect(response.results.every((r) => r.source === 'main')).toBe(true);
  });

  it('total_matches reflects BM25 count on cursor pages', async () => {
    const repo = new SpyMemoryRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler({ ...BASE_INPUT, cursor: A_VALID_CURSOR }, CTX, deps);

    expect(response.total_matches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) recallSemantic throws — BM25-only returned, no throw escapes (M1 lock)
// ---------------------------------------------------------------------------

/**
 * A SpyMemoryRepo variant whose recallSemantic always rejects.
 * Used to verify the Phase-2 fail-soft: a DB blip during the vector scan
 * must not propagate as a 500 — the handler must return BM25 results only.
 */
class RejectingSemanticRepo extends SpyMemoryRepo {
  async recallSemantic(
    _tenant: TenantContext,
    _queryEmbedding: number[],
    _filters: RecallSemanticFilters,
    _excludeIds: string[],
    _k: number,
  ): Promise<MemoryRow[]> {
    this.semanticCallCount++;
    throw new Error('recallSemantic DB failure (intentional test stub)');
  }
}

describe('recallHandler two-phase — (e) recallSemantic throws: Phase-2 fail-soft (M1)', () => {
  const BM25_ROWS = [
    makeMemoryRow('f0000000-0000-0000-0000-000000000001', 'BM25 Row F1'),
    makeMemoryRow('f0000000-0000-0000-0000-000000000002', 'BM25 Row F2'),
  ];

  // totalMatches < N so Phase 2 is attempted; recallSemantic will then throw.
  const recallResult: RecallResult = {
    rows: BM25_ROWS,
    totalMatches: 2, // < N (5) → Phase 2 attempted
    nextCursor: null,
  };

  it('handler resolves (no throw escapes) when recallSemantic rejects', async () => {
    const repo = new RejectingSemanticRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    await expect(recallHandler(BASE_INPUT, CTX, deps)).resolves.toBeDefined();
  });

  it('returns BM25 results only when recallSemantic throws (no semantic rows)', async () => {
    const repo = new RejectingSemanticRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo([STAGED_ITEM]),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    // staged + BM25 only; zero semantic extras
    expect(response.results.length).toBe(1 + BM25_ROWS.length);
    expect(response.results[0]?.source).toBe('staged');
    expect(response.results.slice(1).every((r) => r.source === 'main')).toBe(true);
  });

  it('total_matches reflects BM25 count when recallSemantic throws', async () => {
    const repo = new RejectingSemanticRepo([], recallResult);
    const { embedder } = makeSpyEmbedder(UNIT_VEC);
    const deps: HandlerDeps = {
      memoryRepository: repo,
      stagingRepository: makeStagingRepo(),
      embedder,
      semanticFallbackMinResults: N,
      semanticFallbackK: K,
    };

    const response = await recallHandler(BASE_INPUT, CTX, deps);

    expect(response.total_matches).toBe(recallResult.totalMatches);
  });
});
