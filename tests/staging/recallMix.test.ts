/**
 * T023: recall staging-mix — direct handler unit tests.
 *
 * Covers the staged-item prepend behaviour added to recallHandler:
 *  - First page (no cursor): staged records prepended with source:"staged";
 *    total_matches reflects main count only (staged drafts are additive).
 *  - Cursor page (non-first): staged items NOT fetched; only main records returned.
 *  - No open session: result is identical to recall without staged data.
 *
 * Uses InMemoryMemoryRepository (tests/memory/fakes.ts) for main records and
 * InMemoryStagingRepository (tests/staging/fakes.ts) for staged records.
 * Calls recallHandler directly — no MCP transport needed.
 */

import { describe, it, expect } from 'vitest';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import {
  InMemoryStagingRepository,
  type FakeStagingSession,
  type FakeStagingItem,
} from './fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { RecallRequest } from '../../src/contracts/tools.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'PLACEHOLDER';
const REPO_ID    = 'PLACEHOLDER';
const BRANCH     = 'main';
const SESSION_ID = 'test-session-recall-001';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: BRANCH },
  actor:  { actorId: 'test-actor', roles: ['contributor'] },
};

/** Three main memories in the project — gives total_matches=3 and forces pagination at limit=2. */
const MAIN_MEMORIES: FakeMemory[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    type: 'decision',
    title: 'Architecture decision alpha',
    summary: 'Core architecture decisions for alpha',
    body: 'Detailed architecture rationale for the alpha component.',
    currentRevision: 1,
    updatedAt: new Date('2025-06-03T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    type: 'pattern',
    title: 'Repository pattern for data access',
    summary: 'Standard repository pattern for the data layer',
    body: 'Repository pattern details and guidelines.',
    currentRevision: 1,
    updatedAt: new Date('2025-06-02T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    type: 'constraint',
    title: 'Constraint on external dependencies',
    summary: 'No new runtime dependencies without review',
    body: 'All new runtime dependencies require a formal review.',
    currentRevision: 1,
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    status: 'active',
  },
];

/** Two staged items — should be prepended on the first page only. */
const STAGED_SESSION: FakeStagingSession = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  repoId: REPO_ID,
  branch: BRANCH,
};

const STAGED_ITEMS: FakeStagingItem[] = [
  {
    id: 'dddddddd-d001-0000-0000-000000000001',
    sessionId: SESSION_ID,
    op: 'add',
    type: 'decision',
    title: 'Draft decision one',
    summary: 'Summary of draft decision one',
    body: 'Body of draft decision one.',
    contentHash: 'hash-staged-001',
    createdAt: new Date('2025-07-01T00:00:00Z'),
  },
  {
    id: 'dddddddd-d002-0000-0000-000000000002',
    sessionId: SESSION_ID,
    op: 'add',
    type: 'pattern',
    title: 'Draft pattern two',
    summary: 'Summary of draft pattern two',
    body: 'Body of draft pattern two.',
    contentHash: 'hash-staged-002',
    createdAt: new Date('2025-07-02T00:00:00Z'),
  },
];

/** Recall request with limit=2 so the 3 main memories produce a cursor. */
const BASE_REQUEST: RecallRequest = {
  query: 'architecture decision',
  scope: 'project',
  limit: 2,
};

function makeDeps(
  memories: FakeMemory[],
  stagingRepo: InMemoryStagingRepository,
): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories),
    stagingRepository: stagingRepo,
    // semanticFallbackMinResults: 0 ensures Phase 2 never fires in these staging-mix tests
    // (totalMatches < 0 is always false).
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
    semanticFallbackMinResults: 0,
    semanticFallbackK: 8,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recallHandler — staging-mix on first page', () => {
  it('prepends staged records with source:"staged" before main records', async () => {
    const stagingRepo = new InMemoryStagingRepository([STAGED_SESSION], STAGED_ITEMS);
    const deps = makeDeps(MAIN_MEMORIES, stagingRepo);

    // First page: cursor absent
    const response = await recallHandler(BASE_REQUEST, CTX, deps);

    // At least one staged record must appear
    const stagedResults = response.results.filter((r) => r.source === 'staged');
    expect(stagedResults.length).toBe(2);

    // Staged records come before main records in the results array
    const firstMainIndex = response.results.findIndex((r) => r.source === 'main');
    const lastStagedIndex = response.results.reduce(
      (max, r, idx) => (r.source === 'staged' ? idx : max),
      -1,
    );
    expect(lastStagedIndex).toBeLessThan(firstMainIndex);
  });

  it('staged records carry the correct contract fields', async () => {
    const stagingRepo = new InMemoryStagingRepository([STAGED_SESSION], STAGED_ITEMS);
    const deps = makeDeps(MAIN_MEMORIES, stagingRepo);

    const response = await recallHandler(BASE_REQUEST, CTX, deps);

    const stagedResults = response.results.filter((r) => r.source === 'staged');
    for (const record of stagedResults) {
      expect(record.source).toBe('staged');
      expect(typeof record.handle).toBe('string');
      expect(record.handle.length).toBeGreaterThan(0);
      expect(typeof record.type).toBe('string');
      expect(typeof record.title).toBe('string');
      expect(typeof record.summary).toBe('string');
      expect(typeof record.body).toBe('string');
      expect(typeof record.date).toBe('string');
      expect(record.origin.pr).toBeNull();          // no PR until promotion
      expect(record.origin.branch).toBe(BRANCH);    // branch from tenant context
    }
  });

  it('total_matches reflects main count only — staged drafts are not counted', async () => {
    const stagingRepo = new InMemoryStagingRepository([STAGED_SESSION], STAGED_ITEMS);
    const deps = makeDeps(MAIN_MEMORIES, stagingRepo);

    const response = await recallHandler(BASE_REQUEST, CTX, deps);

    // 3 main memories → total_matches = 3 (staged items do NOT count)
    expect(response.total_matches).toBe(3);

    // results has staged (2) + main page (2) = 4
    expect(response.results.length).toBeGreaterThan(response.total_matches);
  });
});

describe('recallHandler — cursor page skips staged fetch', () => {
  it('cursor page returns NO staged records (only main)', async () => {
    const stagingRepo = new InMemoryStagingRepository([STAGED_SESSION], STAGED_ITEMS);
    const deps = makeDeps(MAIN_MEMORIES, stagingRepo);

    // Fetch page 1 to get the cursor
    const page1 = await recallHandler(BASE_REQUEST, CTX, deps);
    expect(page1.cursor).not.toBeNull();

    // Fetch page 2 using the cursor from page 1
    const page2 = await recallHandler(
      { ...BASE_REQUEST, cursor: page1.cursor! },
      CTX,
      deps,
    );

    // No staged records on cursor pages
    const hasStagedRecord = page2.results.some((r) => r.source === 'staged');
    expect(hasStagedRecord).toBe(false);

    // All results are from main
    for (const record of page2.results) {
      expect(record.source).toBe('main');
    }
  });
});

describe('recallHandler — no open session', () => {
  it('behaves identically to recall without staging when no session exists', async () => {
    // Empty staging repo — listStagingItems will return [] for this tenant
    const emptyStaging = new InMemoryStagingRepository();
    const depsWithEmpty = makeDeps(MAIN_MEMORIES, emptyStaging);

    const responseWithEmpty = await recallHandler(BASE_REQUEST, CTX, depsWithEmpty);

    // No staged records at all
    const hasStagedRecord = responseWithEmpty.results.some((r) => r.source === 'staged');
    expect(hasStagedRecord).toBe(false);

    // total_matches still reflects main count
    expect(responseWithEmpty.total_matches).toBe(3);

    // All results from main
    for (const record of responseWithEmpty.results) {
      expect(record.source).toBe('main');
    }
  });
});
