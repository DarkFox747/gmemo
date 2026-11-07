import { describe, it, expect } from 'vitest';
import { getMemoryHandler } from '../../src/mcp/tools/getMemory.js';
import { encodeHandle } from '../../src/mcp/handle.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { GetMemoryRequest, GetMemoryResponse } from '../../src/contracts/tools.js';
import type { MemoryRecord } from '../../src/contracts/memory.js';

/**
 * T042 (updated for change B): getMemory handler — contract shape conformance.
 *
 * Calls getMemoryHandler directly with a seeded InMemoryMemoryRepository and
 * a real encoded handle (so decodeHandle() succeeds after Group B rewrites
 * the handler body).
 *
 * Asserts that the response carries a fully-shaped MemoryRecord in `memory`,
 * an array in `relations`, and an array in `references`.
 *
 * The stub handler (pre-Group B) ignores _input entirely, so passing a real
 * encoded handle does not break the stub: it always returns the hardcoded
 * placeholder regardless of the handle value.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMORY_ID = '33333333-3333-3333-3333-333333333333';

/** A valid opaque handle for MEMORY_ID at revision 1. */
const VALID_HANDLE = encodeHandle(MEMORY_ID, 1);

const SEED_MEMORY: FakeMemory = {
  id: MEMORY_ID,
  projectId: 'PLACEHOLDER',
  repoId: 'PLACEHOLDER',
  type: 'decision',
  title: 'Placeholder decision detail (get_memory)',
  summary: 'Scaffold placeholder — full detail view.',
  body: 'This record is seeded by the test fake for get_memory shape validation.',
  fields: {},
  currentRevision: 1,
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  originBranch: 'placeholder/scaffold',
  originPr: null,
  status: 'active',
};

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

const VALID_INPUT: GetMemoryRequest = {
  handle: VALID_HANDLE,
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

function makeDeps(memories: FakeMemory[]): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories),
  } as HandlerDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getMemoryHandler — GetMemoryResponse shape', () => {
  it('returns a well-formed GetMemoryResponse', async () => {
    const deps = makeDeps([SEED_MEMORY]);
    const response: GetMemoryResponse = await getMemoryHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    // Top-level keys must be present
    expect(response).toHaveProperty('memory');
    expect(response).toHaveProperty('relations');
    expect(response).toHaveProperty('references');
  });

  it('memory carries all required MemoryRecord keys with correct types', async () => {
    const deps = makeDeps([SEED_MEMORY]);
    const response: GetMemoryResponse = await getMemoryHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    const { memory } = response;

    for (const key of MEMORY_RECORD_KEYS) {
      expect(memory, `memory is missing key "${key}"`).toHaveProperty(key);
    }

    // handle: non-empty string
    expect(typeof memory.handle).toBe('string');
    expect(memory.handle.length).toBeGreaterThan(0);

    // type: one of the seven valid memory types (contract §1)
    expect([
      'decision',
      'constraint',
      'gotcha',
      'pattern',
      'integration_note',
      'domain_rule',
      'outcome',
    ]).toContain(memory.type);

    // title: string, within 120-char budget
    expect(typeof memory.title).toBe('string');
    expect(memory.title.length).toBeLessThanOrEqual(120);

    // summary: string, within 200-char budget
    expect(typeof memory.summary).toBe('string');
    expect(memory.summary.length).toBeLessThanOrEqual(200);

    // body: string
    expect(typeof memory.body).toBe('string');

    // fields: plain object
    expect(typeof memory.fields).toBe('object');
    expect(memory.fields).not.toBeNull();
    expect(Array.isArray(memory.fields)).toBe(false);

    // date: non-empty string
    expect(typeof memory.date).toBe('string');
    expect(memory.date.length).toBeGreaterThan(0);

    // origin: { branch: string; pr: number | null }
    expect(typeof memory.origin).toBe('object');
    expect(memory.origin).not.toBeNull();
    expect(typeof memory.origin.branch).toBe('string');
    expect(
      memory.origin.pr === null || typeof memory.origin.pr === 'number',
    ).toBe(true);

    // source: "main" (D1 — get_memory only surfaces main records)
    expect(memory.source).toBe('main');
  });

  it('relations is an array', async () => {
    const deps = makeDeps([SEED_MEMORY]);
    const response: GetMemoryResponse = await getMemoryHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    expect(Array.isArray(response.relations)).toBe(true);

    // Each relation, if any, must have the correct shape
    for (const rel of response.relations) {
      expect(['supersedes', 'conflicts_with', 'duplicate']).toContain(rel.type);
      expect(typeof rel.handle).toBe('string');
      expect(rel.handle.length).toBeGreaterThan(0);
    }
  });

  it('references is an array', async () => {
    const deps = makeDeps([SEED_MEMORY]);
    const response: GetMemoryResponse = await getMemoryHandler(VALID_INPUT, PLACEHOLDER_CTX, deps);

    expect(Array.isArray(response.references)).toBe(true);

    // Each reference, if any, must be a non-empty string handle
    for (const ref of response.references) {
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
    }
  });
});
