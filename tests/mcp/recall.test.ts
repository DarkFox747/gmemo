import { describe, it, expect } from 'vitest';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { RecallRequest, RecallResponse } from '../../src/contracts/tools.js';
import type { MemoryRecord } from '../../src/contracts/memory.js';
import type { StagingRepository } from '../../src/db/stagingRepository.js';

/**
 * T041 (updated for change B): recall handler — contract shape conformance.
 *
 * Calls recallHandler directly (bypassing MCP transport) with a seeded
 * InMemoryMemoryRepository as deps (RRF hybrid recall).  These tests validate:
 *  - RecallResponse shape (results array, total_matches number, cursor)
 *  - Every MemoryRecord has the required keys with correct types
 *  - source is always "main" (D1: staging deferred — no source:"staged" records)
 *
 * CHANGE from the scaffold test: the "at least one source:'staged'" assertion
 * has been REMOVED (D1 — recall returns source:'main' only).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED_MEMORIES: FakeMemory[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    type: 'decision',
    title: 'Architecture decisions for the system',
    summary: 'Core architecture decisions covering the main components',
    body: 'Detailed architecture rationale for the overall system design.',
    currentRevision: 1,
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    originBranch: 'main',
    originPr: null,
    status: 'active',
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    type: 'pattern',
    title: 'Repository pattern for data access',
    summary: 'Standard pattern for database access layer',
    body: 'Repository pattern details and usage guidelines.',
    currentRevision: 1,
    updatedAt: new Date('2025-05-01T00:00:00Z'),
    originBranch: 'feat/data',
    originPr: 3,
    status: 'active',
  },
];

const PLACEHOLDER_CTX: RequestContext = {
  tenant: {
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    branch: 'main',
  },
  actor: {
    actorId: 'test-actor',
    roles: ['viewer'],
  },
};

const VALID_INPUT: RecallRequest = {
  query: 'architecture decisions',
  scope: 'project',
  limit: 8,
};

/** The complete set of keys required on every MemoryRecord (contract §1). */
const MEMORY_RECORD_KEYS: ReadonlyArray<keyof MemoryRecord> = [
  'handle',
  'type',
  'title',
  'summary',
  'body',
  'fields',
  'date',
  'origin',
  'source',
];

/** Empty staging repository: listStagingItems returns [] so staged-mix adds no records. */
const EMPTY_STAGING_REPO: StagingRepository = {
  findOrCreateOpenSession: () => Promise.resolve(''),
  insertStagingItem: () =>
    Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
  listStagingItems: () => Promise.resolve([]),
  discardStagingItem: () => Promise.resolve(false),
};

function makeDeps(memories: FakeMemory[]): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories),
    stagingRepository: EMPTY_STAGING_REPO,
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recallHandler — RecallResponse shape', () => {
  it('returns a well-formed RecallResponse', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: RecallResponse = await recallHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    // Top-level shape
    expect(Array.isArray(response.results)).toBe(true);
    expect(typeof response.total_matches).toBe('number');
    expect(response.cursor === null || typeof response.cursor === 'string').toBe(true);
  });

  it('total_matches is a non-negative integer', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: RecallResponse = await recallHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    expect(Number.isInteger(response.total_matches)).toBe(true);
    expect(response.total_matches).toBeGreaterThanOrEqual(0);
  });

  it('every result carries all required MemoryRecord keys', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: RecallResponse = await recallHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    // Skip key-shape assertions when there are no results (empty seed case).
    if (response.results.length === 0) return;

    for (const record of response.results) {
      for (const key of MEMORY_RECORD_KEYS) {
        expect(record, `record is missing key "${key}"`).toHaveProperty(key);
      }

      // handle: non-empty string
      expect(typeof record.handle).toBe('string');
      expect(record.handle.length).toBeGreaterThan(0);

      // type: one of the seven valid memory types (contract §1)
      expect([
        'decision',
        'constraint',
        'gotcha',
        'pattern',
        'integration_note',
        'domain_rule',
        'outcome',
      ]).toContain(record.type);

      // title: string, within the 120-char budget (contract §1 / §8)
      expect(typeof record.title).toBe('string');
      expect(record.title.length).toBeLessThanOrEqual(120);

      // summary: string, within the 200-char budget (contract §1 / §8)
      expect(typeof record.summary).toBe('string');
      expect(record.summary.length).toBeLessThanOrEqual(200);

      // body: string
      expect(typeof record.body).toBe('string');

      // fields: plain object (per-type fields)
      expect(typeof record.fields).toBe('object');
      expect(record.fields).not.toBeNull();
      expect(Array.isArray(record.fields)).toBe(false);

      // date: ISO-8601 string
      expect(typeof record.date).toBe('string');
      expect(record.date.length).toBeGreaterThan(0);

      // origin: { branch: string; pr: number | null }
      expect(typeof record.origin).toBe('object');
      expect(record.origin).not.toBeNull();
      expect(typeof record.origin.branch).toBe('string');
      expect(
        record.origin.pr === null || typeof record.origin.pr === 'number',
      ).toBe(true);

      // source: "main" only (D1 — staging is deferred; recall never returns staged records)
      expect(record.source).toBe('main');
    }
  });

  it('cursor is null when all results fit on a single page', async () => {
    // Two records with limit=8 → no second page needed.
    const deps = makeDeps(SEED_MEMORIES);
    const response: RecallResponse = await recallHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    expect(response.cursor).toBeNull();
  });

  it('types: [] returns the same results as omitting types (empty array treated as no filter)', async () => {
    // Both the handler (which normalizes [] to undefined) and the in-memory fake
    // must agree that an empty types filter means "all types".
    const deps = makeDeps(SEED_MEMORIES);
    const base: RecallRequest = { query: 'architecture decisions', scope: 'project', limit: 8 };

    const responseNoTypes: RecallResponse = await recallHandler(base, PLACEHOLDER_CTX, deps);
    const responseEmptyTypes: RecallResponse = await recallHandler(
      { ...base, types: [] },
      PLACEHOLDER_CTX,
      deps,
    );

    expect(responseEmptyTypes.total_matches).toBe(responseNoTypes.total_matches);
    expect(responseEmptyTypes.results.map((r) => r.handle)).toEqual(
      responseNoTypes.results.map((r) => r.handle),
    );
  });
});
