/**
 * T022: discardStagedHandler — direct handler unit tests.
 *
 * Covers:
 *  - own item → {discarded: true}
 *  - unknown item_id → INVALID_REFERENCE
 *  - item belonging to another session → INVALID_REFERENCE (no enumeration)
 */

import { describe, it, expect } from 'vitest';
import { discardStagedHandler } from '../../src/mcp/tools/discardStaged.js';
import {
  InMemoryStagingRepository,
  type FakeStagingSession,
  type FakeStagingItem,
} from './fakes.js';
import { InMemoryMemoryRepository } from '../memory/fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import { ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID       = 'PLACEHOLDER';
const REPO_ID          = 'PLACEHOLDER';
const BRANCH           = 'main';
const SESSION_ID       = 'test-session-discard-001';
const ITEM_ID          = 'aaaaaaaa-d001-0000-0000-000000000001';

// A second session keyed to a different project — items from it must be opaque
const OTHER_PROJECT_ID = 'other-project-0000-0000-0000-000000000000';
const OTHER_SESSION_ID = 'test-session-discard-002';
const OTHER_ITEM_ID    = 'aaaaaaaa-d099-0000-0000-000000000099';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: BRANCH },
  actor:  { actorId: 'test-actor', roles: ['contributor'] },
};

const CALLER_SESSION: FakeStagingSession = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  repoId: REPO_ID,
  branch: BRANCH,
};

const OTHER_SESSION: FakeStagingSession = {
  id: OTHER_SESSION_ID,
  projectId: OTHER_PROJECT_ID,
  repoId: REPO_ID,
  branch: BRANCH,
};

const CALLER_ITEM: FakeStagingItem = {
  id: ITEM_ID,
  sessionId: SESSION_ID,
  op: 'add',
  type: 'decision',
  title: 'Caller-owned staged item',
  summary: 'Summary of caller item',
  body: 'Body of caller item.',
  contentHash: 'hash-discard-caller-001',
};

const OTHER_SESSION_ITEM: FakeStagingItem = {
  id: OTHER_ITEM_ID,
  sessionId: OTHER_SESSION_ID,
  op: 'add',
  type: 'decision',
  title: 'Item in another session',
  summary: 'Summary of item in another project session',
  body: 'Body of the other-session item.',
  contentHash: 'hash-discard-other-001',
};

function makeDeps(stagingRepo: InMemoryStagingRepository): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(),
    stagingRepository: stagingRepo,
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
    semanticFallbackMinResults: 0,
    semanticFallbackK: 8,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discardStagedHandler', () => {
  it('own item → {discarded: true}', async () => {
    const stagingRepo = new InMemoryStagingRepository([CALLER_SESSION], [CALLER_ITEM]);
    const deps = makeDeps(stagingRepo);

    const result = await discardStagedHandler({ item_id: ITEM_ID }, CTX, deps);

    expect(result.discarded).toBe(true);
  });

  it('unknown item_id → INVALID_REFERENCE', async () => {
    const stagingRepo = new InMemoryStagingRepository([CALLER_SESSION], []);
    const deps = makeDeps(stagingRepo);

    await expect(
      discardStagedHandler({ item_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, CTX, deps),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_REFERENCE });
  });

  it('item from another session → INVALID_REFERENCE (no enumeration of other sessions)', async () => {
    // Both sessions are seeded; the caller's tenant resolves only to SESSION_ID.
    // OTHER_ITEM_ID belongs to OTHER_SESSION_ID — the handler must not reveal it exists.
    const stagingRepo = new InMemoryStagingRepository(
      [CALLER_SESSION, OTHER_SESSION],
      [CALLER_ITEM, OTHER_SESSION_ITEM],
    );
    const deps = makeDeps(stagingRepo);

    await expect(
      discardStagedHandler({ item_id: OTHER_ITEM_ID }, CTX, deps),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_REFERENCE });
  });
});
