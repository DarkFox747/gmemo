import { describe, it, expect } from 'vitest';
import { getContextHandler } from '../../src/mcp/tools/getContext.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { GetContextRequest, GetContextResponse } from '../../src/contracts/tools.js';

/**
 * T043 (updated for change B): getContext handler — contract shape conformance.
 *
 * Calls getContextHandler with a seeded InMemoryMemoryRepository as deps.
 * The stub handler (pre-Group B) ignores _deps and returns hardcoded records
 * that already satisfy all these assertions, so the tests also pass before
 * Group B lands (for the shape properties).  After Group B rewrites the handler,
 * the fake's data drives the assertions.
 *
 * Asserts:
 *  - priority ordering rule (constraints and domain_rules first, contract §2)
 *  - stale-marking rule (TTL-expired-active record has stale:true, contract §2)
 *  - staging-exclusion rule (no record has source:"staged", contract §2/§5)
 *  - every record has all required MemoryRecord keys
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixed "now" to make stale computations deterministic.
const NOW = new Date('2026-07-01T00:00:00Z');

const SEED_MEMORIES: FakeMemory[] = [
  // Phase-1 records (always first)
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    type: 'constraint',
    title: 'Placeholder constraint record',
    summary: 'Scaffold placeholder — constraints always lead get_context (contract §2).',
    body: 'Constraints are always included and never dropped for budget reasons.',
    fields: { rule: 'placeholder constraint rule', scope: 'project', consequence: 'none' },
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    type: 'domain_rule',
    title: 'Placeholder domain_rule record',
    summary: 'Scaffold placeholder — domain_rules always lead get_context (contract §2).',
    body: 'Domain rules are always included and never dropped for budget reasons.',
    fields: { rule: 'placeholder domain rule', enforced_in: 'placeholder' },
    updatedAt: new Date('2025-05-01T00:00:00Z'),
    status: 'active',
  },
  // Phase-2 record, stale (TTL expired well before NOW)
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    projectId: 'PLACEHOLDER',
    repoId: 'PLACEHOLDER',
    type: 'decision',
    title: 'Placeholder decision record (stale)',
    summary: 'Scaffold placeholder decision — marked stale:true (TTL-expired, contract §2).',
    body: 'This decision has exceeded its TTL but is still active status.',
    fields: {},
    ttlDays: 30,
    createdAt: new Date('2024-01-01T00:00:00Z'), // far in the past — stale vs NOW
    updatedAt: new Date('2024-01-01T00:00:00Z'),
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

const EMPTY_INPUT: GetContextRequest = {};

function makeDeps(memories: FakeMemory[]): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories, [], () => NOW),
  } as HandlerDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getContextHandler — GetContextResponse shape', () => {
  it('returns a non-empty records array', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: GetContextResponse = await getContextHandler(EMPTY_INPUT, PLACEHOLDER_CTX, deps);

    expect(Array.isArray(response.records)).toBe(true);
    expect(response.records.length).toBeGreaterThan(0);
  });

  it('records[0].type is "constraint" or "domain_rule" (priority ordering, contract §2)', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: GetContextResponse = await getContextHandler(EMPTY_INPUT, PLACEHOLDER_CTX, deps);

    const firstType = response.records[0].type;
    expect(['constraint', 'domain_rule']).toContain(firstType);
  });

  it('at least one record has stale: true (TTL-expired-but-active rule, contract §2)', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: GetContextResponse = await getContextHandler(EMPTY_INPUT, PLACEHOLDER_CTX, deps);

    const hasStaleRecord = response.records.some((r) => r.stale === true);
    expect(hasStaleRecord).toBe(true);
  });

  it('no record has source "staged" (get_context never surfaces staging, contract §2/§5)', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: GetContextResponse = await getContextHandler(EMPTY_INPUT, PLACEHOLDER_CTX, deps);

    const hasStagedRecord = response.records.some((r) => r.source === 'staged');
    expect(hasStagedRecord).toBe(false);
  });

  it('every record carries all required MemoryRecord keys', async () => {
    const deps = makeDeps(SEED_MEMORIES);
    const response: GetContextResponse = await getContextHandler(EMPTY_INPUT, PLACEHOLDER_CTX, deps);

    const MEMORY_RECORD_KEYS = [
      'handle',
      'type',
      'title',
      'summary',
      'body',
      'fields',
      'date',
      'origin',
      'source',
    ] as const;

    for (const record of response.records) {
      for (const key of MEMORY_RECORD_KEYS) {
        expect(record, `record is missing key "${key}"`).toHaveProperty(key);
      }

      // type: one of the seven valid memory types
      expect([
        'decision',
        'constraint',
        'gotcha',
        'pattern',
        'integration_note',
        'domain_rule',
        'outcome',
      ]).toContain(record.type);

      // title and summary within contract §1 budgets
      expect(record.title.length).toBeLessThanOrEqual(120);
      expect(record.summary.length).toBeLessThanOrEqual(200);

      // source must be "main" (staging excluded per rule above)
      expect(record.source).toBe('main');

      // origin shape
      expect(typeof record.origin.branch).toBe('string');
      expect(
        record.origin.pr === null || typeof record.origin.pr === 'number',
      ).toBe(true);
    }
  });
});
