/**
 * T242: getMemory handler — behavior tests via InMemoryMemoryRepository.
 *
 * Cases:
 *  1. Found — valid handle returns full MemoryRecord + mapped relations + references.
 *  2. Stale handle — current_revision > decoded revision → opaque AppError.
 *  3. Not found / cross-project — id absent or different project → opaque AppError.
 *  4. Relations + references — relation edges mapped to {type, handle}; references
 *     is the de-duplicated list of handles from relations (D9).
 *  5. Record with no edges — relations:[], references:[].
 *  6. Malformed handle — invalid base64url or wrong shape → opaque AppError.
 *
 * All cases require Group B to rewrite getMemoryHandler to use deps.memoryRepository.
 */

import { describe, it, expect } from 'vitest';
import { getMemoryHandler } from '../../src/mcp/tools/getMemory.js';
import { encodeHandle } from '../../src/mcp/handle.js';
import { InMemoryMemoryRepository, type FakeMemory, type FakeRelation } from './fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { GetMemoryRequest } from '../../src/contracts/tools.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-beta';
const OTHER_PROJECT = 'project-gamma';

const CTX: RequestContext = {
  tenant: {
    projectId: PROJECT_ID,
    repoId: 'repo-0000-0000-0000-0000-000000000000',
    branch: 'main',
  },
  actor: { actorId: 'test-actor', roles: ['viewer'] },
};

const MEMORY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_MEMORY_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THIRD_MEMORY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const BASE_MEMORY: FakeMemory = {
  id: MEMORY_ID,
  projectId: PROJECT_ID,
  repoId: 'repo-0000-0000-0000-0000-000000000000',
  type: 'decision',
  title: 'Adopt the repository pattern',
  summary: 'Separate data access behind a repository interface',
  body: 'Repository pattern decouples business logic from persistence.',
  fields: { scope: 'architecture', outcome: 'accepted' },
  currentRevision: 1,
  updatedAt: new Date('2025-06-01T00:00:00Z'),
  originBranch: 'feat/data-layer',
  originPr: 7,
};

const RELATED_MEMORY: FakeMemory = {
  id: OTHER_MEMORY_ID,
  projectId: PROJECT_ID,
  repoId: 'repo-0000-0000-0000-0000-000000000000',
  type: 'pattern',
  title: 'Active record pattern (superseded)',
  summary: 'The old pattern that was replaced',
  body: 'Active record details.',
  currentRevision: 2,
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

function makeDeps(memories: FakeMemory[], relations: FakeRelation[] = []): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories, relations),
  } as HandlerDeps;
}

// ---------------------------------------------------------------------------
// 1. Found — well-formed response
// ---------------------------------------------------------------------------

describe('getMemoryHandler — found (no relations)', () => {
  const handle = encodeHandle(MEMORY_ID, 1);
  const input: GetMemoryRequest = { handle };

  it('returns a GetMemoryResponse with memory, relations, and references', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);

    expect(response).toHaveProperty('memory');
    expect(response).toHaveProperty('relations');
    expect(response).toHaveProperty('references');
  });

  it('memory.handle is a non-empty string (re-encoded from current_revision)', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);
    expect(typeof response.memory.handle).toBe('string');
    expect(response.memory.handle.length).toBeGreaterThan(0);
  });

  it('memory.source is "main" (D1)', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);
    expect(response.memory.source).toBe('main');
  });

  it('memory carries the correct type and title from seed', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);
    expect(response.memory.type).toBe('decision');
    expect(response.memory.title).toBe('Adopt the repository pattern');
  });

  it('relations is an empty array when no edges exist', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);
    expect(Array.isArray(response.relations)).toBe(true);
    expect(response.relations).toHaveLength(0);
  });

  it('references is an empty array when no edges exist', async () => {
    const deps = makeDeps([BASE_MEMORY]);
    const response = await getMemoryHandler(input, CTX, deps);
    expect(Array.isArray(response.references)).toBe(true);
    expect(response.references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Stale handle → opaque AppError(INVALID_REFERENCE)
// ---------------------------------------------------------------------------

describe('getMemoryHandler — stale handle', () => {
  it('throws INVALID_REFERENCE when current_revision > decoded revision', async () => {
    // Memory is at revision 2, but handle encodes revision 1.
    const memory: FakeMemory = { ...BASE_MEMORY, currentRevision: 2 };
    const staleHandle = encodeHandle(MEMORY_ID, 1); // stale: revision 1 < current 2
    const input: GetMemoryRequest = { handle: staleHandle };
    const deps = makeDeps([memory]);

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
    await expect(getMemoryHandler(input, CTX, deps)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.INVALID_REFERENCE,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Not found / cross-project → opaque AppError(INVALID_REFERENCE)
// ---------------------------------------------------------------------------

describe('getMemoryHandler — not found / cross-project', () => {
  it('throws INVALID_REFERENCE when the memory id does not exist', async () => {
    const nonExistentHandle = encodeHandle(
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      1,
    );
    const input: GetMemoryRequest = { handle: nonExistentHandle };
    const deps = makeDeps([BASE_MEMORY]); // seeded with different id

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
    await expect(getMemoryHandler(input, CTX, deps)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.INVALID_REFERENCE,
    );
  });

  it('throws INVALID_REFERENCE for a memory in a different project (cross-project guard)', async () => {
    const crossProjectMemory: FakeMemory = {
      ...BASE_MEMORY,
      projectId: OTHER_PROJECT,
    };
    const handle = encodeHandle(MEMORY_ID, 1);
    const input: GetMemoryRequest = { handle };
    const deps = makeDeps([crossProjectMemory]);

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
  });

  it('throws INVALID_REFERENCE for a superseded (non-active) memory', async () => {
    const superseded: FakeMemory = { ...BASE_MEMORY, status: 'superseded' };
    const handle = encodeHandle(MEMORY_ID, 1);
    const input: GetMemoryRequest = { handle };
    const deps = makeDeps([superseded]);

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
  });
});

// ---------------------------------------------------------------------------
// 4. Relations + references mapped
// ---------------------------------------------------------------------------

describe('getMemoryHandler — relations and references', () => {
  const relations: FakeRelation[] = [
    {
      fromMemory: MEMORY_ID,
      toMemory: OTHER_MEMORY_ID,
      relationType: 'supersedes',
    },
  ];

  const handle = encodeHandle(MEMORY_ID, 1);
  const input: GetMemoryRequest = { handle };

  it('maps relation edges to { type, handle } objects', async () => {
    const deps = makeDeps([BASE_MEMORY, RELATED_MEMORY], relations);
    const response = await getMemoryHandler(input, CTX, deps);

    expect(response.relations).toHaveLength(1);
    expect(response.relations[0].type).toBe('supersedes');
    expect(typeof response.relations[0].handle).toBe('string');
    expect(response.relations[0].handle.length).toBeGreaterThan(0);
  });

  it('references is the de-duplicated list of handles from relations', async () => {
    const deps = makeDeps([BASE_MEMORY, RELATED_MEMORY], relations);
    const response = await getMemoryHandler(input, CTX, deps);

    expect(response.references).toHaveLength(1);
    expect(response.references[0]).toBe(response.relations[0].handle);
  });

  it('references is de-duplicated when multiple relation edges point to the same memory', async () => {
    // MEMORY_ID → OTHER_MEMORY_ID via two different relation types.
    const dualRelations: FakeRelation[] = [
      {
        fromMemory: MEMORY_ID,
        toMemory: OTHER_MEMORY_ID,
        relationType: 'supersedes',
      },
      {
        fromMemory: MEMORY_ID,
        toMemory: OTHER_MEMORY_ID,
        relationType: 'conflicts_with',
      },
    ];
    const deps = makeDeps([BASE_MEMORY, RELATED_MEMORY], dualRelations);
    const response = await getMemoryHandler(input, CTX, deps);

    // Two relation edges but only one unique OTHER handle in references.
    expect(response.relations).toHaveLength(2);
    const uniqueRefs = new Set(response.references);
    expect(uniqueRefs.size).toBe(response.references.length); // no duplicates in references
  });

  it('excludes relation edges where the other side is in a different project', async () => {
    const crossRelation: FakeRelation[] = [
      {
        fromMemory: MEMORY_ID,
        toMemory: THIRD_MEMORY_ID,
        relationType: 'supersedes',
      },
    ];
    const crossProjectMemory: FakeMemory = {
      id: THIRD_MEMORY_ID,
      projectId: OTHER_PROJECT,
      repoId: 'repo-0000-0000-0000-0000-000000000000',
      type: 'pattern',
      title: 'Cross-project pattern',
      summary: 'Should not appear',
      body: 'Cross-project record details.',
      currentRevision: 1,
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };
    const deps = makeDeps([BASE_MEMORY, crossProjectMemory], crossRelation);
    const response = await getMemoryHandler(input, CTX, deps);

    // Cross-project edge is filtered out.
    expect(response.relations).toHaveLength(0);
    expect(response.references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed handle → opaque AppError(INVALID_REFERENCE)
// ---------------------------------------------------------------------------

describe('getMemoryHandler — malformed handle', () => {
  it('throws INVALID_REFERENCE for a raw non-encoded string', async () => {
    const input: GetMemoryRequest = { handle: 'not-a-real-handle' };
    const deps = makeDeps([BASE_MEMORY]);

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
    await expect(getMemoryHandler(input, CTX, deps)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.INVALID_REFERENCE,
    );
  });

  it('throws INVALID_REFERENCE for an empty handle string', async () => {
    const input: GetMemoryRequest = { handle: '' };
    const deps = makeDeps([BASE_MEMORY]);

    await expect(getMemoryHandler(input, CTX, deps)).rejects.toThrow(AppError);
  });
});
