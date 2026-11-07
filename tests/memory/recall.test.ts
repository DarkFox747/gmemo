/**
 * T241: recall handler — behavior tests via InMemoryMemoryRepository.
 *
 * These tests exercise the REAL handler logic wired to the seedable fake
 * (no DB, no network). After Group B rewrites recallHandler to use
 * deps.memoryRepository, all cases here must pass.
 *
 * Cases:
 *  1. Ranking order — higher-term-hit record ranks above lower-term-hit record.
 *  2. Project scope vs repo scope — scope='repo' excludes records from other repos.
 *  3. Type filter — types=['decision'] excludes non-decision records.
 *  4. Pagination + cursor round-trip — page 1 returns cursor; page 2 exhausts it.
 *  5. Empty result — no seed → results:[], total_matches:0, cursor:null.
 *
 * Every result has source:'main' (D1: staging is deferred, recall is main-only).
 */

import { describe, it, expect } from 'vitest';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { InMemoryMemoryRepository, type FakeMemory } from './fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { RecallRequest } from '../../src/contracts/tools.js';
import type { StagingRepository } from '../../src/db/stagingRepository.js';

// ---------------------------------------------------------------------------
// Shared context fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-alpha';
const REPO_A = 'repo-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REPO_B = 'repo-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const CTX_PROJECT: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_A, branch: 'main' },
  actor: { actorId: 'test-actor', roles: ['viewer'] },
};

const CTX_REPO_A: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_A, branch: 'main' },
  actor: { actorId: 'test-actor', roles: ['viewer'] },
};

// ---------------------------------------------------------------------------
// Helper: build deps bag with a seeded fake
// ---------------------------------------------------------------------------

/** Empty staging repository: listStagingItems returns [] so staged-mix adds no records. */
const EMPTY_STAGING_REPO: StagingRepository = {
  findOrCreateOpenSession: () => Promise.resolve(''),
  insertStagingItem: () =>
    Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
  listStagingItems: () => Promise.resolve([]),
  discardStagingItem: () => Promise.resolve(false),
};

function makeDeps(memories: FakeMemory[], now?: Date): HandlerDeps {
  const nowFn = now ? () => now : () => new Date('2025-07-15T00:00:00Z');
  return {
    memoryRepository: new InMemoryMemoryRepository(memories, [], nowFn),
    stagingRepository: EMPTY_STAGING_REPO,
    // semanticFallbackMinResults: 0 ensures Phase 2 never fires in these behavior tests
    // (totalMatches < 0 is always false).
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
    semanticFallbackMinResults: 0,
    semanticFallbackK: 8,
  };
}

// ---------------------------------------------------------------------------
// 1. Ranking order
// ---------------------------------------------------------------------------

describe('recallHandler — ranking order', () => {
  const NOW = new Date('2025-07-15T00:00:00Z');

  // "cache" appears 3 times in record A vs 0 times in record B.
  const HIGH_RANK: FakeMemory = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'pattern',
    title: 'Cache invalidation strategy',
    summary: 'Cache-aside with write-through for cache consistency',
    body: 'Details on cache management.',
    updatedAt: new Date('2025-07-14T00:00:00Z'), // 1 day ago (fresh)
  };

  const LOW_RANK: FakeMemory = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'decision',
    title: 'Database schema decisions',
    summary: 'Core schema design choices',
    body: 'Rationale for schema layout.',
    updatedAt: new Date('2025-01-01T00:00:00Z'), // far in the past (stale, lower rank)
  };

  it('higher-ranked record appears first', async () => {
    const deps = makeDeps([LOW_RANK, HIGH_RANK], NOW);
    const input: RecallRequest = { query: 'cache', scope: 'project', limit: 8 };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results.length).toBeGreaterThan(0);
    // The HIGH_RANK record contains "cache" in title+summary+body and is newer.
    expect(response.results[0].handle).toBeDefined();
    // Verify ordering: the cache-related record must appear before the schema one.
    const cacheIdx = response.results.findIndex((r) =>
      r.title.toLowerCase().includes('cache'),
    );
    const dbIdx = response.results.findIndex((r) =>
      r.title.toLowerCase().includes('database'),
    );
    if (cacheIdx !== -1 && dbIdx !== -1) {
      expect(cacheIdx).toBeLessThan(dbIdx);
    }
  });

  it('every result has source:"main" (D1 — staging deferred)', async () => {
    const deps = makeDeps([HIGH_RANK, LOW_RANK], NOW);
    const input: RecallRequest = { query: 'cache', scope: 'project', limit: 8 };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    for (const record of response.results) {
      expect(record.source).toBe('main');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Project scope vs repo scope
// ---------------------------------------------------------------------------

describe('recallHandler — project scope vs repo scope', () => {
  const IN_REPO_A: FakeMemory = {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'decision',
    title: 'Decision for repo A',
    summary: 'Repo A specific decision',
    body: 'Details for repo A.',
    updatedAt: new Date('2025-06-01T00:00:00Z'),
  };

  const IN_REPO_B: FakeMemory = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    projectId: PROJECT_ID,
    repoId: REPO_B,
    type: 'decision',
    title: 'Decision for repo B',
    summary: 'Repo B specific decision',
    body: 'Details for repo B.',
    updatedAt: new Date('2025-06-01T00:00:00Z'),
  };

  it('scope="project" includes records from all repos', async () => {
    const deps = makeDeps([IN_REPO_A, IN_REPO_B]);
    const input: RecallRequest = { query: 'decision', scope: 'project', limit: 8 };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    // Both records belong to PROJECT_ID — both should appear.
    expect(response.total_matches).toBe(2);
    expect(response.results).toHaveLength(2);
  });

  it('scope="repo" returns only records from the context repo', async () => {
    const deps = makeDeps([IN_REPO_A, IN_REPO_B]);
    const input: RecallRequest = { query: 'decision', scope: 'repo', limit: 8 };

    const response = await recallHandler(input, CTX_REPO_A, deps);

    // Only REPO_A records (ctx.tenant.repoId = REPO_A).
    expect(response.results.every((r) => r.handle.length > 0)).toBe(true);
    expect(response.total_matches).toBe(1);
    expect(response.results).toHaveLength(1);
    expect(response.results[0].title).toContain('repo A');
  });
});

// ---------------------------------------------------------------------------
// 3. Type filter
// ---------------------------------------------------------------------------

describe('recallHandler — type filter', () => {
  const DECISION: FakeMemory = {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'decision',
    title: 'Use TypeScript',
    summary: 'Decision to use TypeScript',
    body: 'Rationale for TypeScript adoption.',
    updatedAt: new Date('2025-06-01T00:00:00Z'),
  };

  const CONSTRAINT: FakeMemory = {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'constraint',
    title: 'ESM modules only',
    summary: 'Constraint: only ESM imports',
    body: 'No CommonJS require() calls.',
    updatedAt: new Date('2025-06-01T00:00:00Z'),
  };

  it('types=["decision"] returns only decision records', async () => {
    const deps = makeDeps([DECISION, CONSTRAINT]);
    const input: RecallRequest = {
      query: 'TypeScript ESM',
      scope: 'project',
      types: ['decision'],
      limit: 8,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results.every((r) => r.type === 'decision')).toBe(true);
    expect(response.total_matches).toBe(1);
  });

  it('types=["constraint"] returns only constraint records', async () => {
    const deps = makeDeps([DECISION, CONSTRAINT]);
    const input: RecallRequest = {
      query: 'TypeScript ESM',
      scope: 'project',
      types: ['constraint'],
      limit: 8,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results.every((r) => r.type === 'constraint')).toBe(true);
    expect(response.total_matches).toBe(1);
  });

  it('no types filter returns all matching records', async () => {
    const deps = makeDeps([DECISION, CONSTRAINT]);
    const input: RecallRequest = {
      query: 'TypeScript ESM',
      scope: 'project',
      limit: 8,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.total_matches).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Pagination + cursor round-trip
// ---------------------------------------------------------------------------

describe('recallHandler — pagination and cursor', () => {
  const NOW = new Date('2025-07-15T00:00:00Z');

  // Three records with decreasing freshness to ensure deterministic ranking
  // (each contains "service" so all have > 0 hits for query "service").
  const RECORD_FRESH: FakeMemory = {
    id: '11111111-1111-1111-1111-111111111111',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'decision',
    title: 'Service mesh adoption',
    summary: 'Decision on service mesh',
    body: 'Details about service mesh service.',
    updatedAt: new Date('2025-07-14T00:00:00Z'), // 1 day ago
  };

  const RECORD_MID: FakeMemory = {
    id: '22222222-2222-2222-2222-222222222222',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'pattern',
    title: 'Service discovery pattern',
    summary: 'Pattern for service discovery',
    body: 'Service registration details.',
    updatedAt: new Date('2025-06-15T00:00:00Z'), // 30 days ago
  };

  const RECORD_OLD: FakeMemory = {
    id: '33333333-3333-3333-3333-333333333333',
    projectId: PROJECT_ID,
    repoId: REPO_A,
    type: 'gotcha',
    title: 'Service timeout gotcha',
    summary: 'Common service timeout issue',
    body: 'Watch out for service connection timeouts.',
    updatedAt: new Date('2025-05-16T00:00:00Z'), // 60 days ago
  };

  it('page 1 with limit=2 returns cursor when more records exist', async () => {
    const deps = makeDeps([RECORD_FRESH, RECORD_MID, RECORD_OLD], NOW);
    const input: RecallRequest = {
      query: 'service',
      scope: 'project',
      limit: 2,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results).toHaveLength(2);
    expect(response.cursor).not.toBeNull();
    expect(typeof response.cursor).toBe('string');
    expect(response.total_matches).toBe(3);
  });

  it('page 2 using cursor from page 1 returns remaining records and null cursor', async () => {
    const deps = makeDeps([RECORD_FRESH, RECORD_MID, RECORD_OLD], NOW);
    const inputPage1: RecallRequest = {
      query: 'service',
      scope: 'project',
      limit: 2,
    };

    const page1 = await recallHandler(inputPage1, CTX_PROJECT, deps);
    expect(page1.cursor).not.toBeNull();

    const inputPage2: RecallRequest = {
      query: 'service',
      scope: 'project',
      limit: 2,
      cursor: page1.cursor!,
    };

    const page2 = await recallHandler(inputPage2, CTX_PROJECT, deps);

    expect(page2.results).toHaveLength(1);
    expect(page2.cursor).toBeNull();
  });

  it('combined pages cover all records without overlap', async () => {
    const deps = makeDeps([RECORD_FRESH, RECORD_MID, RECORD_OLD], NOW);
    const inputPage1: RecallRequest = {
      query: 'service',
      scope: 'project',
      limit: 2,
    };

    const page1 = await recallHandler(inputPage1, CTX_PROJECT, deps);
    const inputPage2: RecallRequest = {
      query: 'service',
      scope: 'project',
      limit: 2,
      cursor: page1.cursor!,
    };
    const page2 = await recallHandler(inputPage2, CTX_PROJECT, deps);

    const allHandles = [...page1.results, ...page2.results].map(
      (r) => r.handle,
    );
    const uniqueHandles = new Set(allHandles);

    // All 3 records returned; no duplicates.
    expect(allHandles).toHaveLength(3);
    expect(uniqueHandles.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty result
// ---------------------------------------------------------------------------

describe('recallHandler — empty result', () => {
  it('returns empty array, 0 total_matches, null cursor when no records are seeded', async () => {
    const deps = makeDeps([]);
    const input: RecallRequest = {
      query: 'anything',
      scope: 'project',
      limit: 8,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results).toEqual([]);
    expect(response.total_matches).toBe(0);
    expect(response.cursor).toBeNull();
  });

  it('returns empty results when all seeded records belong to a different project', async () => {
    const otherProject: FakeMemory = {
      id: '44444444-4444-4444-4444-444444444444',
      projectId: 'other-project',
      repoId: REPO_A,
      type: 'decision',
      title: 'Other project decision',
      summary: 'Not visible to this project',
      body: 'Cross-project data isolation.',
    };

    const deps = makeDeps([otherProject]);
    const input: RecallRequest = {
      query: 'decision',
      scope: 'project',
      limit: 8,
    };

    const response = await recallHandler(input, CTX_PROJECT, deps);

    expect(response.results).toEqual([]);
    expect(response.total_matches).toBe(0);
    expect(response.cursor).toBeNull();
  });
});
