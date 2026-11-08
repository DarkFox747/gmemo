/**
 * Read-path status exclusion (C4, memory-read delta; HU-12.1).
 *
 * For each non-active status (superseded, deprecated, pending_revalidation),
 * alongside one active row with matching content, the MCP read handlers return
 * only the active row: recall (BM25 + semantic fallback), get_memory (opaque
 * INVALID_REFERENCE, identical to an unknown handle) and get_context.
 * The SQL predicates are covered by tests/db/statusExclusion.integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { getMemoryHandler } from '../../src/mcp/tools/getMemory.js';
import { getContextHandler } from '../../src/mcp/tools/getContext.js';
import { encodeHandle } from '../../src/mcp/handle.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { HandlerDeps, RequestContext } from '../../src/mcp/context.js';
import type { StagingRepository } from '../../src/db/stagingRepository.js';
import type { MemoryType } from '../../src/contracts/memory.js';
import { InMemoryMemoryRepository, type FakeMemory } from './fakes.js';

const PROJECT_ID = 'project-status-exclusion';
const REPO_ID = 'repo-status-exclusion';
const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' },
  actor: { actorId: 'tester', roles: ['viewer'] },
};
const UNIT_VEC: number[] = [1, ...new Array(1023).fill(0)];
const ACTIVE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HIDDEN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNKNOWN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const NON_ACTIVE = ['superseded', 'deprecated', 'pending_revalidation'] as const;

const emptyStaging: StagingRepository = {
  findOrCreateOpenSession: () => Promise.resolve(''),
  insertStagingItem: () =>
    Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
  listStagingItems: () => Promise.resolve([]),
  discardStagingItem: () => Promise.resolve(false),
};

function memory(
  id: string,
  type: MemoryType,
  status: FakeMemory['status'],
  title: string,
): FakeMemory {
  return {
    id,
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    type,
    title,
    summary: 'Shared lifecycle exclusion summary',
    body: 'Shared lifecycle exclusion body',
    status,
    embedding: UNIT_VEC,
  };
}

function makeDeps(memories: FakeMemory[]): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories),
    stagingRepository: emptyStaging,
    embedder: { embed: () => Promise.resolve(UNIT_VEC) },
    notifier: { notify: () => Promise.resolve() },
  };
}

async function expectInvalidReference(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(ErrorCode.INVALID_REFERENCE);
  return err as AppError;
}

describe.each(NON_ACTIVE)('a %s memory is never served', (status) => {
  it('recall (BM25) returns only the active row and counts only it', async () => {
    const deps = makeDeps([
      memory(ACTIVE_ID, 'decision', 'active', 'Active lifecycle row'),
      memory(HIDDEN_ID, 'decision', status, 'Hidden lifecycle row'),
    ]);
    const res = await recallHandler({ query: 'lifecycle exclusion', scope: 'project' }, CTX, deps);
    expect(res.results.map((r) => r.title)).toEqual(['Active lifecycle row']);
    expect(res.total_matches).toBe(1);
  });

  it('recall semantic fallback never adds the hidden row', async () => {
    // BM25 (1 match) < N (5) → Phase 2 fires; the hidden row has a matching embedding.
    const deps = makeDeps(
      [
        memory(ACTIVE_ID, 'decision', 'active', 'Active lifecycle row'),
        memory(HIDDEN_ID, 'decision', status, 'Hidden lifecycle row'),
      ],
      5,
    );
    const res = await recallHandler({ query: 'lifecycle exclusion', scope: 'project' }, CTX, deps);
    expect(res.results.map((r) => r.title)).toEqual(['Active lifecycle row']);
  });

  it('get_memory on the hidden handle fails exactly like an unknown handle', async () => {
    const deps = makeDeps([memory(HIDDEN_ID, 'decision', status, 'Hidden lifecycle row')]);
    const hidden = await expectInvalidReference(
      getMemoryHandler({ handle: encodeHandle(HIDDEN_ID, 1) }, CTX, deps),
    );
    const unknown = await expectInvalidReference(
      getMemoryHandler({ handle: encodeHandle(UNKNOWN_ID, 1) }, CTX, deps),
    );
    expect(hidden.message).toBe(unknown.message);
  });

  it('get_memory relations exclude a hidden other side', async () => {
    const memories = [
      memory(ACTIVE_ID, 'decision', 'active', 'Active lifecycle row'),
      memory(HIDDEN_ID, 'decision', status, 'Hidden lifecycle row'),
    ];
    const deps: HandlerDeps = {
      ...makeDeps([]),
      memoryRepository: new InMemoryMemoryRepository(memories, [
        { fromMemory: ACTIVE_ID, toMemory: HIDDEN_ID, relationType: 'supersedes' },
      ]),
    };
    const res = await getMemoryHandler({ handle: encodeHandle(ACTIVE_ID, 1) }, CTX, deps);
    expect(res.relations).toEqual([]);
  });

  it('get_context excludes it from phase 1 (constraint) and phase 2 (decision)', async () => {
    const deps = makeDeps([
      memory(ACTIVE_ID, 'constraint', 'active', 'Active constraint'),
      memory(HIDDEN_ID, 'constraint', status, 'Hidden constraint'),
      memory('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'decision', 'active', 'Active decision'),
      memory('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'decision', status, 'Hidden decision'),
    ]);
    const res = await getContextHandler({}, CTX, deps);
    expect(res.records.map((r) => r.title).sort()).toEqual([
      'Active constraint',
      'Active decision',
    ]);
  });
});
