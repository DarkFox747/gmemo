/**
 * T016: PromoteService embedding behaviour unit tests.
 *
 * DB-free: exercises the embed-before-applyAccepted path via a SpyEmbedder and
 * the same in-file fake patterns used in promoteService.test.ts.
 *
 * Covered cases:
 *  - accepted add     → embedder.embed called once with "title\nsummary\nbody";
 *                       returned vector forwarded to applyAccepted (non-null)
 *  - accepted amend   → same embed call / forwarding behaviour
 *  - accepted supersede → same embed call / forwarding behaviour
 *  - accepted deprecate → embedder.embed NEVER called; applyAccepted receives null
 *  - embed throws      → applyAccepted receives null; item still applied; no throw
 *                        escapes; no quarantine
 */

import { describe, it, expect } from 'vitest';
import { PromoteService } from '../../src/promote/promoteService.js';
import type { PromoteMeta } from '../../src/promote/promoteService.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
  ApplyResult,
  Verdict,
} from '../../src/db/promotionRepository.js';
import type { Judge, JudgeItem } from '../../src/judge/judge.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type {
  AuditLogger,
  TenantContext,
  RequestContext,
  ToolName,
} from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fakes (same patterns as promoteService.test.ts)
// ---------------------------------------------------------------------------

/**
 * SpyEmbedder: records every embed() call; returns a fixed vector or throws,
 * depending on how it is constructed.
 */
class SpyEmbedder implements Embedder {
  readonly embedCalls: string[] = [];

  constructor(private readonly behaviour: number[] | Error = [0.1, 0.2, 0.3]) {}

  embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    if (this.behaviour instanceof Error) {
      return Promise.reject(this.behaviour);
    }
    return Promise.resolve(this.behaviour);
  }
}

/** Controllable fake for PromotionRepository (mirrors promoteService.test.ts). */
class FakePromotionRepository implements PromotionRepository {
  readonly quarantineCalls: Array<{
    item: PromotionItemRow;
    ctx: ApplyContext;
    reason: string;
    redact: boolean;
  }> = [];

  readonly verdictCalls: Array<{
    itemId: string;
    verdict: Verdict;
    reason: string | null;
  }> = [];

  readonly finalizeCalls: Array<{
    sessionId: string;
    status: 'promoted' | 'rejected' | 'partially_promoted';
  }> = [];

  readonly applyAcceptedCalls: Array<{
    item: PromotionItemRow;
    ctx: ApplyContext;
    embedding: number[] | null;
  }> = [];

  constructor(
    private readonly items: PromotionItemRow[] = [],
    private readonly applyResults: Map<string, ApplyResult> = new Map(),
  ) {}

  findOpenSessionId(_tenant: TenantContext): Promise<string | null> {
    return Promise.resolve('test-session');
  }

  fetchPromotableItems(_sessionId: string, _projectId: string): Promise<PromotionItemRow[]> {
    return Promise.resolve(this.items);
  }

  recordVerdict(itemId: string, verdict: Verdict, reason: string | null): Promise<void> {
    this.verdictCalls.push({ itemId, verdict, reason });
    return Promise.resolve();
  }

  applyAccepted(
    item: PromotionItemRow,
    ctx: ApplyContext,
    embedding: number[] | null,
  ): Promise<ApplyResult> {
    this.applyAcceptedCalls.push({ item, ctx, embedding });
    const scripted = this.applyResults.get(item.id);
    if (scripted) return Promise.resolve(scripted);
    return Promise.resolve({ status: 'applied', memoryId: `mem-${item.id}`, deduped: false });
  }

  quarantineItem(
    item: PromotionItemRow,
    ctx: ApplyContext,
    reason: string,
    redact: boolean,
  ): Promise<void> {
    this.quarantineCalls.push({ item, ctx, reason, redact });
    return Promise.resolve();
  }

  finalizeSession(
    sessionId: string,
    status: 'promoted' | 'rejected' | 'partially_promoted',
  ): Promise<void> {
    this.finalizeCalls.push({ sessionId, status });
    return Promise.resolve();
  }
}

/** Controllable fake for Judge. */
class FakeJudge implements Judge {
  readonly evaluateCalls: JudgeItem[] = [];

  constructor(private readonly verdicts: Verdict[] = ['accepted']) {}

  evaluate(item: JudgeItem): Promise<Verdict> {
    this.evaluateCalls.push(item);
    const idx = this.evaluateCalls.length - 1;
    const verdict =
      idx < this.verdicts.length
        ? this.verdicts[idx]!
        : this.verdicts[this.verdicts.length - 1]!;
    return Promise.resolve(verdict);
  }
}

/** Silent no-op fake for AuditLogger. */
class FakeAuditLogger implements AuditLogger {
  recordRead(_ctx: RequestContext, _tool: ToolName, _queryHash?: string): Promise<void> {
    return Promise.resolve();
  }

  recordWrite(
    _ctx: RequestContext,
    _params: {
      tool: 'remember' | 'discard_staged';
      sessionId?: string;
      itemId: string;
      contentHash?: string;
    },
  ): Promise<void> {
    return Promise.resolve();
  }

  recordPromote(
    _ctx: RequestContext,
    _p: {
      sessionId: string;
      applied: number;
      quarantined: number;
      uncertain: number;
      prNumber: number | null;
      mergeSha: string | null;
    },
  ): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-embed-001';

const META: PromoteMeta = {
  tenant: { projectId: 'proj-1', repoId: 'repo-1', branch: 'main' },
  actor: { actorId: 'ci-actor', roles: ['service_agent'] },
  originBranch: 'main',
  originPr: 1,
  mergeSha: 'sha-embed',
};

/** Builds a PromotionItemRow with safe defaults. */
function makeItem(
  id: string,
  overrides: Partial<Omit<PromotionItemRow, 'id'>> = {},
): PromotionItemRow {
  return {
    id,
    op: 'add',
    type: 'decision',
    title: 'Embed title',
    summary: 'Embed summary.',
    body: 'Embed body.',
    fields: {},
    content_hash: `hash-${id}`,
    target_memory_id: null,
    target_revision: null,
    judge_state: 'pending',
    judge_reason: null,
    author_identity: 'test-author',
    promoted_at: null,
    promoted_memory_id: null,
    ...overrides,
  };
}

/**
 * Wire a PromoteService with controllable fakes.
 * The caller supplies the SpyEmbedder so it can assert on it directly.
 */
function makeService(
  items: PromotionItemRow[],
  embedder: Embedder,
  verdicts: Verdict[] = ['accepted'],
  applyResults: Map<string, ApplyResult> = new Map(),
): { service: PromoteService; repo: FakePromotionRepository } {
  const repo = new FakePromotionRepository(items, applyResults);
  const judge = new FakeJudge(verdicts);
  const auditLogger = new FakeAuditLogger();
  const service = new PromoteService({ promotionRepository: repo, judge, auditLogger, embedder });
  return { service, repo };
}

// ---------------------------------------------------------------------------
// Tests: accepted ops (add / amend / supersede) → embed called + vector forwarded
// ---------------------------------------------------------------------------

describe('PromoteService embedding — accepted add/amend/supersede', () => {
  for (const op of ['add', 'amend', 'supersede'] as const) {
    it(`accepted ${op} → embedder.embed called once with "title\\nsummary\\nbody"; non-null vector passed to applyAccepted`, async () => {
      const vector = [0.1, 0.2, 0.3];
      const embedder = new SpyEmbedder(vector);
      const item = makeItem(`emb-${op}`, {
        op,
        title: 'My title',
        summary: 'My summary.',
        body: 'My body.',
        // amend / supersede need a target; irrelevant to embedding but realistic
        target_memory_id: op !== 'add' ? 'mem-target-1' : null,
        target_revision: op !== 'add' ? 1 : null,
      });

      const { service, repo } = makeService([item], embedder);
      await service.promote(SESSION_ID, META);

      // embed called exactly once
      expect(embedder.embedCalls).toHaveLength(1);

      // embed text is the concatenation required by Decision 8
      expect(embedder.embedCalls[0]).toBe('My title\nMy summary.\nMy body.');

      // applyAccepted received the vector (non-null)
      expect(repo.applyAcceptedCalls).toHaveLength(1);
      expect(repo.applyAcceptedCalls[0]!.embedding).not.toBeNull();
      expect(repo.applyAcceptedCalls[0]!.embedding).toEqual(vector);
    });
  }
});

// ---------------------------------------------------------------------------
// Test: accepted deprecate → embed NOT called; applyAccepted receives null
// ---------------------------------------------------------------------------

describe('PromoteService embedding — accepted deprecate', () => {
  it('accepted deprecate → embedder.embed NEVER called; applyAccepted receives null embedding', async () => {
    const embedder = new SpyEmbedder([0.9, 0.8]);
    const item = makeItem('emb-dep', {
      op: 'deprecate',
      target_memory_id: 'mem-to-deprecate',
    });

    const { service, repo } = makeService([item], embedder);
    const outcome = await service.promote(SESSION_ID, META);

    // embed must not be called for deprecate
    expect(embedder.embedCalls).toHaveLength(0);

    // applyAccepted is still called (deprecate is a valid op)
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls[0]!.embedding).toBeNull();

    // Item is counted as applied
    expect(outcome.applied).toBe(1);
    expect(outcome.status).toBe('promoted');
  });
});

// ---------------------------------------------------------------------------
// Test: embed throws → fail-soft (null forwarded; item still applied; no throw)
// ---------------------------------------------------------------------------

describe('PromoteService embedding — embed throws (fail-soft)', () => {
  it('embed throws → applyAccepted receives null; item still applied; no exception escapes; no quarantine', async () => {
    const embedder = new SpyEmbedder(new Error('Bedrock unavailable'));
    const item = makeItem('emb-throw', { op: 'add' });

    const { service, repo } = makeService([item], embedder);

    // promote() must not throw even when embed throws
    const outcome = await service.promote(SESSION_ID, META);

    // embed was attempted
    expect(embedder.embedCalls).toHaveLength(1);

    // applyAccepted still called with null (fail-soft)
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls[0]!.embedding).toBeNull();

    // Item is counted as applied — the embedding failure does not block promotion
    expect(outcome.applied).toBe(1);
    expect(outcome.quarantined).toBe(0);
    expect(outcome.status).toBe('promoted');
  });
});
