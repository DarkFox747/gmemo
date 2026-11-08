/**
 * rankActiveMemories — the single hybrid ranking path shared by MCP recall and
 * the web search explorer: fused order, rank provenance, semantic availability
 * flag, repo priority only with a repo, repo-scope guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { rankActiveMemories, type HybridSearchDeps } from '../../src/search/hybridSearch.js';
import { fuseRrf, prioritizeRepo, RRF_CANDIDATES } from '../../src/search/rrf.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type { MemoryRow } from '../../src/db/memoryRepository.js';
import { logger } from '../../src/observability/logger.js';

const PROJECT_ID = 'proj-hybrid';
const MINE = 'repo-mine';
const OTHER = 'repo-other';
const UPDATED_AT = new Date('2025-06-01T00:00:00Z');
const QUERY_VEC = [1, 0, 0];
const QUERY = 'alpha beta';

const id = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(1);
const B = id(2);
const C = id(3);
const X = id(4);

function mem(over: Partial<FakeMemory> & Pick<FakeMemory, 'id'>): FakeMemory {
  return {
    projectId: PROJECT_ID,
    repoId: OTHER,
    type: 'decision',
    title: 'title',
    summary: 'summary',
    body: 'body',
    updatedAt: UPDATED_AT,
    ...over,
  };
}

// A: lexical 1st (2 hits), semantic 3rd. B: lexical 2nd (1 hit), no embedding.
// C: no lexical hit, semantic 1st. X: semantic 2nd only, in MINE.
const SCENARIO: FakeMemory[] = [
  mem({ id: A, title: 'alpha beta', embedding: [0.6, 0.8, 0] }),
  mem({ id: B, title: 'alpha', embedding: null }),
  mem({ id: C, embedding: [1, 0, 0] }),
  mem({ id: X, repoId: MINE, embedding: [0.9, 0.43589, 0] }),
];

const fixedEmbedder = (vec: number[]): Embedder => ({ embed: () => Promise.resolve(vec) });

function deps(
  repo = new InMemoryMemoryRepository(SCENARIO),
  embedder?: Embedder,
): HybridSearchDeps {
  return { memoryRepository: repo, embedder: embedder ?? fixedEmbedder(QUERY_VEC) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rankActiveMemories', () => {
  it('equals the previous inline recall logic (fuseRrf + prioritizeRepo) and records provenance', async () => {
    const repo = new InMemoryMemoryRepository(SCENARIO);
    const tenant = { projectId: PROJECT_ID, repoId: MINE };

    const { ranked, semantic } = await rankActiveMemories(deps(repo), tenant, {
      query: QUERY,
      scope: 'project',
    });

    const lexical = await repo.recallLexicalCandidates(
      { ...tenant, branch: 'main' },
      { query: QUERY, scope: 'project' },
      RRF_CANDIDATES,
    );
    const sem = await repo.recallSemantic(
      { ...tenant, branch: 'main' },
      QUERY_VEC,
      { scope: 'project' },
      [],
      RRF_CANDIDATES,
    );
    const expected = prioritizeRepo(fuseRrf(lexical, sem), MINE);

    expect(semantic).toBe('ok');
    expect(ranked).toEqual(expected);
    expect(ranked.map((f) => f.row.id)).toEqual([X, A, C, B]);
    const byId = new Map(ranked.map((f) => [f.row.id, f]));
    expect(byId.get(A)).toMatchObject({ lexicalRank: 1, semanticRank: 3 });
    expect(byId.get(B)).toMatchObject({ lexicalRank: 2, semanticRank: null });
    expect(byId.get(C)).toMatchObject({ lexicalRank: null, semanticRank: 1 });
  });

  it('forwards limit 50, empty excludeIds, scope, types and the tenant repo to both queries', async () => {
    const repo = new InMemoryMemoryRepository(SCENARIO);
    const lexical = vi.spyOn(repo, 'recallLexicalCandidates');
    const semantic = vi.spyOn(repo, 'recallSemantic');
    const tenant = { projectId: PROJECT_ID, repoId: MINE };

    await rankActiveMemories(deps(repo), tenant, {
      query: QUERY,
      scope: 'repo',
      types: ['decision'],
    });

    expect(lexical).toHaveBeenCalledTimes(1);
    expect(lexical).toHaveBeenCalledWith(
      tenant,
      { query: QUERY, scope: 'repo', types: ['decision'] },
      50,
    );
    expect(semantic).toHaveBeenCalledTimes(1);
    expect(semantic).toHaveBeenCalledWith(
      tenant,
      QUERY_VEC,
      { scope: 'repo', types: ['decision'] },
      [],
      50,
    );
    expect(RRF_CANDIDATES).toBe(50);
    expect(lexical.mock.calls[0]![0].repoId).toBe(MINE);
  });

  it('project scope without a repo applies no priority (pure fused order)', async () => {
    const { ranked } = await rankActiveMemories(
      deps(),
      { projectId: PROJECT_ID, repoId: null },
      { query: QUERY, scope: 'project' },
    );
    expect(ranked.map((f) => f.row.id)).toEqual([A, C, B, X]); // B and X tie on 1/62; id breaks it
  });

  it('embedder throws: lexical ranking, semantic unavailable, one warning with the error name only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    class EmbedderDownError extends Error {
      override name = 'EmbedderDownError';
    }
    const down: Embedder = {
      embed: () => Promise.reject(new EmbedderDownError('connection refused')),
    };

    const { ranked, semantic } = await rankActiveMemories(
      deps(new InMemoryMemoryRepository(SCENARIO), down),
      { projectId: PROJECT_ID, repoId: null },
      { query: QUERY, scope: 'project' },
    );

    expect(semantic).toBe('unavailable');
    expect(ranked.map((f) => f.row.id)).toEqual([A, B]);
    expect(ranked.every((f) => f.semanticRank === null)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('EmbedderDownError');
    expect(message).not.toContain(QUERY);
    expect(message).not.toContain('connection refused');
  });

  it('semantic query throws: semantic unavailable and one warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    class FailingSemanticRepo extends InMemoryMemoryRepository {
      async recallSemantic(): Promise<MemoryRow[]> {
        throw new Error('vector index unavailable');
      }
    }

    const { ranked, semantic } = await rankActiveMemories(
      deps(new FailingSemanticRepo(SCENARIO)),
      { projectId: PROJECT_ID, repoId: null },
      { query: QUERY, scope: 'project' },
    );

    expect(semantic).toBe('unavailable');
    expect(ranked.map((f) => f.row.id)).toEqual([A, B]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain('vector index unavailable');
  });

  it('an empty semantic list that did not throw is ok', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const noEmbeddings = SCENARIO.map((m) => ({ ...m, embedding: null }));

    const { semantic, ranked } = await rankActiveMemories(
      deps(new InMemoryMemoryRepository(noEmbeddings)),
      { projectId: PROJECT_ID, repoId: null },
      { query: QUERY, scope: 'project' },
    );

    expect(semantic).toBe('ok');
    expect(ranked.map((f) => f.row.id)).toEqual([A, B]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('repo scope without a repo throws instead of widening to the project', async () => {
    await expect(
      rankActiveMemories(
        deps(),
        { projectId: PROJECT_ID, repoId: null },
        { query: QUERY, scope: 'repo' },
      ),
    ).rejects.toThrow();
  });

  it('a lexical failure propagates', async () => {
    class FailingLexicalRepo extends InMemoryMemoryRepository {
      async recallLexicalCandidates(): Promise<MemoryRow[]> {
        throw new Error('db down');
      }
    }
    await expect(
      rankActiveMemories(
        deps(new FailingLexicalRepo(SCENARIO)),
        { projectId: PROJECT_ID, repoId: null },
        { query: QUERY, scope: 'project' },
      ),
    ).rejects.toThrow('db down');
  });
});
