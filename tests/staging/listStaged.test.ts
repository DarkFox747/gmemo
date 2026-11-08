/**
 * T021: listStagedHandler — direct handler unit tests.
 *
 * Covers:
 *  - own-session items are returned as StagedItemView records
 *  - empty / no open session → {items: []}
 */

import { describe, it, expect } from 'vitest';
import { listStagedHandler } from '../../src/mcp/tools/listStaged.js';
import {
  InMemoryStagingRepository,
  type FakeStagingSession,
  type FakeStagingItem,
} from './fakes.js';
import { InMemoryMemoryRepository } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'PLACEHOLDER';
const REPO_ID    = 'PLACEHOLDER';
const BRANCH     = 'main';
const SESSION_ID = 'test-session-list-001';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: BRANCH },
  actor:  { actorId: 'test-actor', roles: ['contributor'] },
};

const SEEDED_SESSION: FakeStagingSession = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  repoId: REPO_ID,
  branch: BRANCH,
};

const SEEDED_ITEMS: FakeStagingItem[] = [
  {
    id: 'aaaaaaaa-0001-0000-0000-000000000001',
    sessionId: SESSION_ID,
    op: 'add',
    type: 'decision',
    title: 'First staged decision',
    summary: 'Summary of the first staged decision',
    body: 'Body of the first staged decision.',
    contentHash: 'hash-list-001',
    createdAt: new Date('2025-06-01T00:00:00Z'),
  },
  {
    id: 'aaaaaaaa-0002-0000-0000-000000000002',
    sessionId: SESSION_ID,
    op: 'add',
    type: 'constraint',
    title: 'A constraint record',
    summary: 'Summary of the constraint',
    body: 'Body of the constraint record.',
    contentHash: 'hash-list-002',
    createdAt: new Date('2025-06-02T00:00:00Z'),
  },
];

function makeDeps(stagingRepo: InMemoryStagingRepository): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(),
    stagingRepository: stagingRepo,
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listStagedHandler', () => {
  it('own-session items are returned with correct StagedItemView shape', async () => {
    const stagingRepo = new InMemoryStagingRepository([SEEDED_SESSION], SEEDED_ITEMS);
    const deps = makeDeps(stagingRepo);

    const response = await listStagedHandler({}, CTX, deps);

    expect(Array.isArray(response.items)).toBe(true);
    expect(response.items).toHaveLength(2);

    for (const item of response.items) {
      // id: non-empty string
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);

      // op: one of the four staging operations
      expect(['add', 'amend', 'supersede', 'deprecate']).toContain(item.op);

      // type: one of the seven memory types
      expect([
        'decision', 'constraint', 'gotcha', 'pattern',
        'integration_note', 'domain_rule', 'outcome',
      ]).toContain(item.type);

      // title / summary: non-empty strings within budget
      expect(typeof item.title).toBe('string');
      expect(item.title.length).toBeGreaterThan(0);
      expect(typeof item.summary).toBe('string');

      // state: judge_state string
      expect(typeof item.state).toBe('string');
      expect(item.state.length).toBeGreaterThan(0);

      // date: ISO-8601 string
      expect(typeof item.date).toBe('string');
      expect(() => new Date(item.date)).not.toThrow();
    }
  });

  it('empty session (no session keyed to this tenant) → {items: []}', async () => {
    // No sessions seeded — listStagingItems returns [] for an unknown tenant key
    const stagingRepo = new InMemoryStagingRepository();
    const deps = makeDeps(stagingRepo);

    const response = await listStagedHandler({}, CTX, deps);

    expect(response.items).toEqual([]);
  });
});

describe('listStagedHandler — pending mandatory review is visible (SEC L-9)', () => {
  function item(id: string, extra: Partial<FakeStagingItem>): FakeStagingItem {
    return { ...SEEDED_ITEMS[0]!, id, contentHash: `hash-${id}`, ...extra };
  }

  it('accepted + mandatory_review, not applied → state "uncertain"; other states unchanged', async () => {
    const stagingRepo = new InMemoryStagingRepository(
      [SEEDED_SESSION],
      [
        item('m-pending', { judgeState: 'accepted', mandatoryReview: true }),
        item('m-applied', {
          judgeState: 'accepted',
          mandatoryReview: true,
          promotedAt: new Date('2025-06-03T00:00:00Z'),
        }),
        item('plain-accepted', { judgeState: 'accepted' }),
        item('rejected', { judgeState: 'rejected', mandatoryReview: true }),
      ],
    );

    const { items } = await listStagedHandler({}, CTX, makeDeps(stagingRepo));
    const state = Object.fromEntries(items.map((i) => [i.id, i.state]));

    expect(state).toEqual({
      'm-pending': 'uncertain',
      'm-applied': 'accepted',
      'plain-accepted': 'accepted',
      rejected: 'rejected',
    });
  });
});

// ---------------------------------------------------------------------------
// R2-SEC1: reserved branch prefixes (restore/, web/) are server-owned
// ---------------------------------------------------------------------------

describe('listStagedHandler — reserved branches (R2-SEC1)', () => {
  it.each(['restore/11111111-1111-4111-8111-111111111111', 'web/anything', 'web/'])(
    'branch %s → opaque INVALID_REFERENCE, even when a session exists there',
    async (branch) => {
      const session: FakeStagingSession = { ...SEEDED_SESSION, branch };
      const stagingRepo = new InMemoryStagingRepository([session], SEEDED_ITEMS);
      const ctx: RequestContext = { ...CTX, tenant: { ...CTX.tenant, branch } };
      await expect(listStagedHandler({}, ctx, makeDeps(stagingRepo))).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      });
    },
  );

  it('a non-reserved look-alike (restored/x) still lists normally', async () => {
    const session: FakeStagingSession = { ...SEEDED_SESSION, branch: 'restored/x' };
    const stagingRepo = new InMemoryStagingRepository([session], SEEDED_ITEMS);
    const ctx: RequestContext = { ...CTX, tenant: { ...CTX.tenant, branch: 'restored/x' } };
    const res = await listStagedHandler({}, ctx, makeDeps(stagingRepo));
    expect(res.items.length).toBe(SEEDED_ITEMS.length);
  });
});
