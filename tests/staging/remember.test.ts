/**
 * T020: rememberHandler — direct handler unit tests.
 *
 * Covers all cases listed in the write-path Test Plan:
 *  - add → {id, state:'pending'}
 *  - amend with FRESH handle → state:'pending'
 *  - amend with STALE handle → state:'uncertain'
 *  - amend with unknown/cross-project target → INVALID_REFERENCE
 *  - add + target_handle → INVALID_REFERENCE
 *  - amend without target_handle → INVALID_REFERENCE
 *  - duplicate content → same id (dedup, no second insert)
 *  - unknown fields key → INVALID_REFERENCE
 *  - AWS access key in body → PERMISSION_DENIED, nothing persisted
 *  - PEM private key in body → PERMISSION_DENIED, nothing persisted
 *  - JWT in body → PERMISSION_DENIED, nothing persisted
 */

import { describe, it, expect } from 'vitest';
import { rememberHandler } from '../../src/mcp/tools/remember.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import { InMemoryStagingRepository, RecordingNotifier } from './fakes.js';
import type { RequestContext, HandlerDeps } from '../../src/mcp/context.js';
import type { RememberRequest } from '../../src/contracts/tools.js';
import { encodeHandle } from '../../src/mcp/handle.js';
import { ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Project the handler's tenant is scoped to. */
const PROJECT_ID = 'PLACEHOLDER';
const REPO_ID = 'PLACEHOLDER';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' },
  actor: { actorId: 'test-actor', roles: ['contributor'] },
};

/** Valid UUID used as the target memory id for amend tests. */
const TARGET_MEMORY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TARGET_CURRENT_REVISION = 3;

const TARGET_MEMORY: FakeMemory = {
  id: TARGET_MEMORY_ID,
  projectId: PROJECT_ID,
  type: 'decision',
  title: 'Existing decision',
  summary: 'Existing decision summary',
  body: 'Existing decision body.',
  currentRevision: TARGET_CURRENT_REVISION,
  status: 'active',
};

/** Minimal valid add input — no secrets, all fields within budget. */
const BASE_ADD: RememberRequest = {
  op: 'add',
  type: 'decision',
  title: 'Architecture approach',
  summary: 'Chose microservices for independent scaling',
  body: 'We chose microservices because each service can scale independently.',
};

function makeDeps(
  memories: FakeMemory[] = [],
  stagingRepo = new InMemoryStagingRepository(),
  notifier = new RecordingNotifier(),
): HandlerDeps {
  return {
    memoryRepository: new InMemoryMemoryRepository(memories),
    stagingRepository: stagingRepo,
    embedder: { embed: (_: string) => Promise.resolve([] as number[]) },
    semanticFallbackMinResults: 0,
    semanticFallbackK: 8,
    notifier,
  };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('rememberHandler — add', () => {
  it('add returns {id: string, state:"pending"}', async () => {
    const deps = makeDeps();
    const result = await rememberHandler(BASE_ADD, CTX, deps);

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// amend
// ---------------------------------------------------------------------------

describe('rememberHandler — amend', () => {
  it('amend with a FRESH handle → state:"pending"', async () => {
    // Fresh: encoded revision === current_revision
    const freshHandle = encodeHandle(TARGET_MEMORY_ID, TARGET_CURRENT_REVISION);
    const input: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Architecture approach — revised',
      summary: 'Revised microservices decision with fresh handle',
      body: 'Updated rationale after final review.',
      target_handle: freshHandle,
    };
    const deps = makeDeps([TARGET_MEMORY]);
    const result = await rememberHandler(input, CTX, deps);

    expect(result.state).toBe('pending');
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('amend with a STALE handle → state:"uncertain"', async () => {
    // Stale: encoded revision (1) < current_revision (3) → isHandleStale returns true
    const staleHandle = encodeHandle(TARGET_MEMORY_ID, 1);
    const input: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Architecture approach — stale amend',
      summary: 'Amend using a handle behind the current revision',
      body: 'Memory has been amended since this handle was issued.',
      target_handle: staleHandle,
    };
    const deps = makeDeps([TARGET_MEMORY]);
    const result = await rememberHandler(input, CTX, deps);

    expect(result.state).toBe('uncertain');
  });

  describe('stale target (HU-11.3)', () => {
    const staleInput: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Stale amend',
      summary: 'Amend using a handle behind the current revision',
      body: 'Memory has been amended since this handle was issued.',
      target_handle: encodeHandle(TARGET_MEMORY_ID, 1),
    };

    it('stores stale_target + mandatory_review and notifies review_enqueued once', async () => {
      const repo = new InMemoryStagingRepository();
      const notifier = new RecordingNotifier();
      const deps = makeDeps([TARGET_MEMORY], repo, notifier);

      const result = await rememberHandler(staleInput, CTX, deps);

      expect(repo.insertedParams[0]).toMatchObject({
        judgeState: 'uncertain',
        judgeCriterion: 'stale_target',
        mandatoryReview: true,
        judgeReason: 'target revision is no longer current',
      });
      expect(notifier.events).toEqual([
        {
          projectId: PROJECT_ID,
          event: {
            type: 'review_enqueued',
            itemId: result.id,
            queue: 'uncertain',
            criterion: 'stale_target',
          },
        },
      ]);
    });

    it('dedup re-submission does not notify again', async () => {
      const repo = new InMemoryStagingRepository();
      const notifier = new RecordingNotifier();
      const deps = makeDeps([TARGET_MEMORY], repo, notifier);

      await rememberHandler(staleInput, CTX, deps);
      await rememberHandler(staleInput, CTX, deps);

      expect(repo.insertedItemCount).toBe(1);
      expect(notifier.events).toHaveLength(1);
    });

    it('a failing notifier does not fail the write', async () => {
      const repo = new InMemoryStagingRepository();
      const deps = makeDeps([TARGET_MEMORY], repo, new RecordingNotifier(true));

      await expect(rememberHandler(staleInput, CTX, deps)).resolves.toMatchObject({
        state: 'uncertain',
      });
    });
  });

  it('fresh amend and add do not notify nor set queue columns', async () => {
    const repo = new InMemoryStagingRepository();
    const notifier = new RecordingNotifier();
    const deps = makeDeps([TARGET_MEMORY], repo, notifier);
    await rememberHandler(BASE_ADD, CTX, deps);

    expect(notifier.events).toHaveLength(0);
    expect(repo.insertedParams[0]).toMatchObject({
      judgeCriterion: null,
      mandatoryReview: false,
      judgeReason: null,
    });
  });

  it('amend with unknown target (not found in memory repo) → INVALID_REFERENCE', async () => {
    const unknownMemoryId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const handle = encodeHandle(unknownMemoryId, 1);
    const input: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Amend unknown target',
      summary: 'Target memory does not exist',
      body: 'getMemoryByHandle returns null — must throw INVALID_REFERENCE.',
      target_handle: handle,
    };
    const deps = makeDeps([]); // no memories seeded

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('amend with cross-project target → INVALID_REFERENCE', async () => {
    // Memory exists but belongs to a different project; getMemoryByHandle returns null
    const crossProjectMemory: FakeMemory = {
      ...TARGET_MEMORY,
      projectId: 'other-project-0000-0000-0000-000000000000',
    };
    const handle = encodeHandle(TARGET_MEMORY_ID, TARGET_CURRENT_REVISION);
    const input: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Cross-project amend attempt',
      summary: 'Target belongs to a different project',
      body: 'Tenant boundary enforced by getMemoryByHandle project-id filter.',
      target_handle: handle,
    };
    const deps = makeDeps([crossProjectMemory]); // seeded under a different project

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
  });
});

// ---------------------------------------------------------------------------
// op ↔ target_handle consistency
// ---------------------------------------------------------------------------

describe('rememberHandler — op↔target_handle validation', () => {
  it('add + target_handle present → INVALID_REFERENCE', async () => {
    const handle = encodeHandle(TARGET_MEMORY_ID, TARGET_CURRENT_REVISION);
    const input: RememberRequest = {
      ...BASE_ADD,
      op: 'add',
      target_handle: handle,
    };
    const deps = makeDeps([TARGET_MEMORY]);

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
  });

  it('amend without target_handle → INVALID_REFERENCE', async () => {
    const input: RememberRequest = {
      op: 'amend',
      type: 'decision',
      title: 'Amend missing handle',
      summary: 'target_handle is absent — required for non-add operations',
      body: 'Handler must reject amend with no target_handle.',
      // target_handle intentionally omitted
    };
    const deps = makeDeps([TARGET_MEMORY]);

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency (dedup)
// ---------------------------------------------------------------------------

describe('rememberHandler — dedup', () => {
  it('duplicate content → same id returned, no second insert', async () => {
    const stagingRepo = new InMemoryStagingRepository();
    const deps = makeDeps([], stagingRepo);

    const result1 = await rememberHandler(BASE_ADD, CTX, deps);
    const result2 = await rememberHandler(BASE_ADD, CTX, deps);

    // Same content → same canonical hash → same pre-existing item id
    expect(result2.id).toBe(result1.id);
    // Only one real insert; second call hit the dedup path
    expect(stagingRepo.insertedItemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fields policy
// ---------------------------------------------------------------------------

describe('rememberHandler — fields policy', () => {
  it('unknown fields key for the given type → INVALID_REFERENCE', async () => {
    // 'decision' allows only 'alternatives' and 'drivers'
    const input: RememberRequest = {
      ...BASE_ADD,
      type: 'decision',
      fields: { unknownKey: 'some value' },
    };
    const deps = makeDeps();

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
  });
});

// ---------------------------------------------------------------------------
// Fields size bound (M1 — ReDoS/CPU-exhaustion prevention)
// ---------------------------------------------------------------------------

describe('rememberHandler — fields size bound', () => {
  it('oversized fields (JSON > 2000 chars) → INVALID_REFERENCE, nothing persisted', async () => {
    // Build a fields object whose JSON serialization exceeds the 2000-char limit.
    // 'decision' allows 'alternatives' and 'drivers'; using 'alternatives' with a long value.
    const largeValue = 'x'.repeat(2001);
    const input: RememberRequest = {
      ...BASE_ADD,
      type: 'decision',
      fields: { alternatives: largeValue },
    };
    const stagingRepo = new InMemoryStagingRepository();
    const deps = makeDeps([], stagingRepo);

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.INVALID_REFERENCE,
    });
    expect(stagingRepo.insertedItemCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

describe('rememberHandler — secret scan', () => {
  /**
   * Helper: assert the handler rejects with PERMISSION_DENIED and that the
   * staging repo received zero inserts (scan fires before any DB write).
   */
  async function assertSecretRejected(input: RememberRequest): Promise<void> {
    const stagingRepo = new InMemoryStagingRepository();
    const deps = makeDeps([], stagingRepo);

    await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
    expect(stagingRepo.insertedItemCount).toBe(0);
  }

  it('AWS access key in body → PERMISSION_DENIED, nothing persisted', async () => {
    // AKIA + 16 uppercase alphanumeric chars → matches aws_access_key_id pattern
    await assertSecretRejected({
      ...BASE_ADD,
      body: 'We used AKIAIOSFODNN7EXAMPLE as the credential for the deployment job.',
    });
  });

  it('PEM private key block in body → PERMISSION_DENIED, nothing persisted', async () => {
    await assertSecretRejected({
      ...BASE_ADD,
      body: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    });
  });

  it('JWT in body → PERMISSION_DENIED, nothing persisted', async () => {
    // Minimal JWT-shaped string: eyJ<header>.eyJ<payload>.<signature>
    await assertSecretRejected({
      ...BASE_ADD,
      body: 'Stored token: eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.fakesig',
    });
  });
});

// ---------------------------------------------------------------------------
// SEC M-1: a non-add op cannot change the target memory type
// ---------------------------------------------------------------------------

describe('rememberHandler — target type must match (SEC M-1)', () => {
  it.each(['amend', 'supersede', 'deprecate'] as const)(
    '%s with a type different from the target → INVALID_REFERENCE, nothing persisted',
    async (op) => {
      const stagingRepo = new InMemoryStagingRepository();
      const deps = makeDeps([TARGET_MEMORY], stagingRepo); // target type: decision
      const input: RememberRequest = {
        op,
        type: 'gotcha',
        title: 'Downgrade the decision to a gotcha',
        summary: 'Type change would bypass the mandatory review',
        body: 'An agent must not be able to change the type of a governed memory.',
        target_handle: encodeHandle(TARGET_MEMORY_ID, TARGET_CURRENT_REVISION),
      };

      await expect(rememberHandler(input, CTX, deps)).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFERENCE,
      });
      expect(stagingRepo.insertedItemCount).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// SEC M-2: capture-time scan runs over a normalized copy
// ---------------------------------------------------------------------------

describe('rememberHandler — secret scan over a normalized copy (SEC M-2)', () => {
  it('zero-width-split AWS key → PERMISSION_DENIED, nothing persisted', async () => {
    const stagingRepo = new InMemoryStagingRepository();
    const deps = makeDeps([], stagingRepo);
    await expect(
      rememberHandler(
        { ...BASE_ADD, body: 'Credential AKIA\u200bIOSFODNN7\u2060EXAMPLE used by the job.' },
        CTX,
        deps,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(stagingRepo.insertedItemCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEC-L2: reserved branch prefixes (restore/, web/)
// ---------------------------------------------------------------------------

describe('rememberHandler — reserved branches (SEC-L2)', () => {
  it.each(['restore/11111111-1111-4111-8111-111111111111', 'restore/x', 'web/anything', 'web/'])(
    'branch %s → INVALID_REFERENCE, no session or item created',
    async (branch) => {
      const repo = new InMemoryStagingRepository();
      const ctx: RequestContext = { ...CTX, tenant: { ...CTX.tenant, branch } };
      await expect(rememberHandler(BASE_ADD, ctx, makeDeps([], repo))).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFERENCE,
      });
      expect(repo.insertedParams).toHaveLength(0);
      expect(await repo.listStagingItems(ctx.tenant)).toEqual([]);
    },
  );

  it.each(['restored/x', 'feature/restore/x', 'webapp/x', 'main'])(
    'branch %s is not reserved',
    async (branch) => {
      const ctx: RequestContext = { ...CTX, tenant: { ...CTX.tenant, branch } };
      const res = await rememberHandler(BASE_ADD, ctx, makeDeps());
      expect(res.state).toBe('pending');
    },
  );
});
