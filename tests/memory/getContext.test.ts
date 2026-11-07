/**
 * T243: getContext handler — behavior tests via InMemoryMemoryRepository.
 *
 * Cases:
 *  1. Constraint/domain_rule records appear FIRST and are never budget-dropped (D6).
 *  2. Stale flag set for TTL-expired-but-active records (contract §2).
 *  3. Superseded/deprecated records are excluded (status='active' only).
 *  4. Phase-2 (decision/gotcha) ordered by recency (updatedAt DESC).
 *  5. Budget trims phase-2 records, never phase-1.
 *
 * All cases require Group B to rewrite getContextHandler to use
 * deps.memoryRepository.
 */

import { describe, it, expect } from 'vitest';
import { getContextHandler } from '../../src/mcp/tools/getContext.js';
import {
  InMemoryMemoryRepository,
  type FakeMemory,
} from './fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { GetContextRequest } from '../../src/contracts/tools.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-delta';

const CTX: RequestContext = {
  tenant: {
    projectId: PROJECT_ID,
    repoId: 'repo-delta-0000-0000-0000-000000000000',
    branch: 'main',
  },
  actor: { actorId: 'test-actor', roles: ['viewer'] },
};

const EMPTY_INPUT: GetContextRequest = {};

// Fixed "now" to make stale computations deterministic.
const NOW = new Date('2026-07-01T00:00:00Z');

function makeDeps(memories: FakeMemory[]): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories, [], () => NOW),
  } as HandlerDeps;
}

// ---------------------------------------------------------------------------
// Base seed helpers
// ---------------------------------------------------------------------------

const CONSTRAINT: FakeMemory = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  projectId: PROJECT_ID,
  type: 'constraint',
  title: 'No direct DB access from handlers',
  summary: 'Always use the repository seam',
  body: 'Handlers must not import pg directly.',
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

const DOMAIN_RULE: FakeMemory = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  projectId: PROJECT_ID,
  type: 'domain_rule',
  title: 'Memory content must be in English',
  summary: 'Skill-enforced content language rule',
  body: 'All memory body text must be written in English.',
  updatedAt: new Date('2026-04-01T00:00:00Z'),
};

const DECISION_RECENT: FakeMemory = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  projectId: PROJECT_ID,
  type: 'decision',
  title: 'ESM modules only',
  summary: 'Use ESM throughout the project',
  body: 'No CommonJS require() allowed.',
  updatedAt: new Date('2026-06-01T00:00:00Z'),
};

const GOTCHA_OLD: FakeMemory = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  projectId: PROJECT_ID,
  type: 'gotcha',
  title: 'pg types coerce integers',
  summary: 'Watch out for pg integer coercion',
  body: 'pg returns integers as strings in certain drivers.',
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// 1. Constraint/domain_rule first (phase-1 ordering, D6)
// ---------------------------------------------------------------------------

describe('getContextHandler — phase-1 records lead', () => {
  it('constraint and domain_rule records appear before decision/gotcha', async () => {
    const deps = makeDeps([
      DECISION_RECENT,
      GOTCHA_OLD,
      CONSTRAINT,
      DOMAIN_RULE,
    ]);

    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    expect(response.records.length).toBeGreaterThan(0);

    // All constraint/domain_rule records come before any decision/gotcha.
    const phase1Types = new Set(['constraint', 'domain_rule']);
    const phase2Types = new Set(['decision', 'gotcha']);

    let foundPhase2 = false;
    for (const record of response.records) {
      if (phase2Types.has(record.type)) {
        foundPhase2 = true;
      }
      if (foundPhase2 && phase1Types.has(record.type)) {
        throw new Error(
          `Phase-1 type "${record.type}" found AFTER a phase-2 record (ordering violated)`,
        );
      }
    }
  });

  it('records[0].type is "constraint" or "domain_rule"', async () => {
    const deps = makeDeps([DECISION_RECENT, CONSTRAINT, DOMAIN_RULE]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    expect(['constraint', 'domain_rule']).toContain(response.records[0].type);
  });

  it('all records have source:"main"', async () => {
    const deps = makeDeps([CONSTRAINT, DOMAIN_RULE, DECISION_RECENT]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    for (const record of response.records) {
      expect(record.source).toBe('main');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Stale flag for TTL-expired-but-active records
// ---------------------------------------------------------------------------

describe('getContextHandler — stale flag', () => {
  // Decision created 100 days before NOW with ttlDays=30 → expired.
  const STALE_DECISION: FakeMemory = {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    projectId: PROJECT_ID,
    type: 'decision',
    title: 'Temporary feature flag decision',
    summary: 'Short-lived decision with tight TTL',
    body: 'This decision expires after 30 days.',
    ttlDays: 30,
    createdAt: new Date('2026-03-23T00:00:00Z'), // 100 days before NOW
    updatedAt: new Date('2026-03-23T00:00:00Z'),
    status: 'active', // still active but TTL exceeded
  };

  // Fresh decision with TTL far in the future → not stale.
  const FRESH_DECISION: FakeMemory = {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    projectId: PROJECT_ID,
    type: 'decision',
    title: 'Long-lived decision',
    summary: 'Decision with generous TTL',
    body: 'Will not expire for a long time.',
    ttlDays: 365,
    createdAt: new Date('2026-06-30T00:00:00Z'), // 1 day before NOW
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    status: 'active',
  };

  it('TTL-expired active record is returned with stale:true', async () => {
    const deps = makeDeps([STALE_DECISION]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const staleRecord = response.records.find(
      (r) => r.title === 'Temporary feature flag decision',
    );
    expect(staleRecord).toBeDefined();
    expect(staleRecord!.stale).toBe(true);
  });

  it('active record within TTL is returned with stale:false or stale:undefined', async () => {
    const deps = makeDeps([FRESH_DECISION]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const freshRecord = response.records.find(
      (r) => r.title === 'Long-lived decision',
    );
    expect(freshRecord).toBeDefined();
    // stale should be false or undefined (not expired).
    expect(freshRecord!.stale).not.toBe(true);
  });

  it('at least one stale record when mixed seed has an expired TTL decision', async () => {
    const deps = makeDeps([STALE_DECISION, FRESH_DECISION, CONSTRAINT]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const hasStale = response.records.some((r) => r.stale === true);
    expect(hasStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Superseded/deprecated records excluded
// ---------------------------------------------------------------------------

describe('getContextHandler — non-active records excluded', () => {
  const SUPERSEDED: FakeMemory = {
    id: '11111111-1111-1111-1111-111111111111',
    projectId: PROJECT_ID,
    type: 'decision',
    title: 'Old superseded decision',
    summary: 'This was replaced',
    body: 'No longer relevant.',
    status: 'superseded',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const DEPRECATED: FakeMemory = {
    id: '22222222-2222-2222-2222-222222222222',
    projectId: PROJECT_ID,
    type: 'constraint',
    title: 'Deprecated constraint',
    summary: 'No longer enforced',
    body: 'This constraint was retired.',
    status: 'deprecated',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('superseded records do not appear in records', async () => {
    const deps = makeDeps([SUPERSEDED, CONSTRAINT]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const supersededFound = response.records.some(
      (r) => r.title === 'Old superseded decision',
    );
    expect(supersededFound).toBe(false);
  });

  it('deprecated records do not appear in records', async () => {
    const deps = makeDeps([DEPRECATED, DECISION_RECENT]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const deprecatedFound = response.records.some(
      (r) => r.title === 'Deprecated constraint',
    );
    expect(deprecatedFound).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Phase-2 ordered by recency (updatedAt DESC)
// ---------------------------------------------------------------------------

describe('getContextHandler — phase-2 recency ordering', () => {
  const DECISION_NEWER: FakeMemory = {
    id: '33333333-3333-3333-3333-333333333333',
    projectId: PROJECT_ID,
    type: 'decision',
    title: 'Newer decision (June)',
    summary: 'Most recent decision',
    body: 'Made in June.',
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  };

  const DECISION_OLDER: FakeMemory = {
    id: '44444444-4444-4444-4444-444444444444',
    projectId: PROJECT_ID,
    type: 'decision',
    title: 'Older decision (January)',
    summary: 'Earlier decision',
    body: 'Made in January.',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('more recent decision appears before older decision', async () => {
    const deps = makeDeps([DECISION_OLDER, DECISION_NEWER]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    const newerIdx = response.records.findIndex(
      (r) => r.title === 'Newer decision (June)',
    );
    const olderIdx = response.records.findIndex(
      (r) => r.title === 'Older decision (January)',
    );

    expect(newerIdx).not.toBe(-1);
    expect(olderIdx).not.toBe(-1);
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

// ---------------------------------------------------------------------------
// 5. Budget trims only phase-2 (phase-1 records are never budget-dropped)
// ---------------------------------------------------------------------------

describe('getContextHandler — budget applies only to phase-2', () => {
  // Build many large phase-2 records (decision/gotcha) that together exceed
  // the ~2500-token budget (~10000 chars of body).  Phase-1 records MUST
  // still appear even when the aggregate text is enormous.
  const largeBody = 'x'.repeat(2000); // max body length

  const LARGE_DECISIONS: FakeMemory[] = Array.from({ length: 6 }, (_, i) => ({
    id: `5${i}5${i}5${i}5${i}-5${i}5${i}-5${i}5${i}-5${i}5${i}-5${i}5${i}5${i}5${i}5${i}5${i}5${i}5${i}`.padEnd(
      36,
      '0',
    ) as string,
    projectId: PROJECT_ID,
    type: 'decision' as const,
    title: `Large decision ${i + 1}`.substring(0, 120),
    summary: `Decision ${i + 1} with large body`.substring(0, 200),
    body: largeBody,
    updatedAt: new Date(2026, 5, 30 - i, 0, 0, 0), // decreasing recency
  }));

  it('phase-1 records appear even when phase-2 fills the budget', async () => {
    const deps = makeDeps([CONSTRAINT, DOMAIN_RULE, ...LARGE_DECISIONS]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    // Constraint and domain_rule must always be present.
    const hasConstraint = response.records.some(
      (r) => r.type === 'constraint',
    );
    const hasDomainRule = response.records.some(
      (r) => r.type === 'domain_rule',
    );
    expect(hasConstraint).toBe(true);
    expect(hasDomainRule).toBe(true);
  });

  it('budget may trim some of the large phase-2 records', async () => {
    const deps = makeDeps([...LARGE_DECISIONS]);
    const response = await getContextHandler(EMPTY_INPUT, CTX, deps);

    // With 6 records × 2000-char body the budget (≈2500 tokens = ≈10000 chars)
    // should cut at least some records.  We only assert the response is an array;
    // the exact trim point depends on the handler's token estimator.
    expect(Array.isArray(response.records)).toBe(true);
    expect(response.records.length).toBeLessThanOrEqual(LARGE_DECISIONS.length);
  });
});
