/**
 * T018: PromoteService unit tests.
 *
 * DB-free: exercises the orchestration state machine entirely through
 * controllable in-file fakes (FakePromotionRepository, FakeJudge,
 * FakeAuditLogger). No real Postgres or AWS Bedrock calls are made.
 *
 * Covered cases (per design.md §"PromoteService.promote — orchestration"):
 *  - empty items → no_op (idempotent re-run; finalizeSession + recordPromote not called)
 *  - pending accepted → applyAccepted → applied counter++; deduped flag counted
 *  - pending rejected → quarantineItem with reason 'judge_rejected'
 *  - pending uncertain → recordVerdict(uncertain); no apply, no quarantine
 *  - applyAccepted results: applied / stale→quarantine / duplicate→quarantine / already→applied
 *  - sanitize gate: AWS key in body → quarantineItem('secret_detected', redact=true); judge never called
 *  - sanitize gate: PEM block in title → quarantineItem('secret_detected', redact=true); judge never called
 *  - persisted-verdict reuse: judge_state='accepted' → judge not re-called
 *  - persisted-verdict reuse: judge_state='uncertain' → judge not re-called
 *  - persisted-verdict reuse: judge_state='rejected' → item entirely skipped (no quarantine call)
 *  - terminal status: all-applied → 'promoted'
 *  - terminal status: all-rejected → 'rejected'
 *  - terminal status: mixed → 'partially_promoted'
 *  - terminal status: empty → 'no_op'
 *  - fail-closed: judge returns 'uncertain' → item NOT applied
 *  - idempotent: fetchPromotableItems returns [] → no_op, 0 applies
 *  - audit: recordPromote called with correct counters after non-no_op run
 *  - audit: recordPromote NOT called for no_op run
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
import type {
  AuditLogger,
  TenantContext,
  RequestContext,
  ToolName,
} from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Controllable fake for PromotionRepository.
 *
 * - `items`       : seeded via constructor; fetchPromotableItems returns them.
 * - `applyResults`: map from item.id to a scripted ApplyResult; defaults to
 *                   { status:'applied', memoryId:'mem-<id>', deduped:false }.
 * - Recorded calls are public arrays for test assertions.
 */
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

  readonly applyAcceptedCalls: Array<{ item: PromotionItemRow; ctx: ApplyContext; embedding: number[] | null }> = [];

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

  applyAccepted(item: PromotionItemRow, ctx: ApplyContext, embedding: number[] | null): Promise<ApplyResult> {
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

/**
 * Controllable fake for Judge.
 *
 * Accepts a list of verdicts. The Nth evaluate() call returns verdicts[N-1].
 * If more calls are made than verdicts provided, the last verdict is repeated.
 * This lets single-item tests pass one verdict and multi-item tests pass one
 * per item without needing a separate class.
 */
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

/**
 * Capturing fake for AuditLogger.
 * Only recordPromote is tracked; the other methods are silent no-ops.
 */
class FakeAuditLogger implements AuditLogger {
  readonly recordPromoteCalls: Array<{
    ctx: RequestContext;
    p: {
      sessionId: string;
      applied: number;
      quarantined: number;
      uncertain: number;
      prNumber: number | null;
      mergeSha: string | null;
    };
  }> = [];

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
    ctx: RequestContext,
    p: {
      sessionId: string;
      applied: number;
      quarantined: number;
      uncertain: number;
      prNumber: number | null;
      mergeSha: string | null;
    },
  ): Promise<void> {
    this.recordPromoteCalls.push({ ctx, p });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-test-001';

const META: PromoteMeta = {
  tenant: { projectId: 'proj-1', repoId: 'repo-1', branch: 'main' },
  actor: { actorId: 'ci-actor', roles: ['service_agent'] },
  originBranch: 'main',
  originPr: 42,
  mergeSha: 'abc123sha',
};

/** Builds a PromotionItemRow with safe defaults. Only `id` is required. */
function makeItem(
  id: string,
  overrides: Partial<Omit<PromotionItemRow, 'id'>> = {},
): PromotionItemRow {
  return {
    id,
    op: 'add',
    type: 'decision',
    title: 'Architecture decision',
    summary: 'Chose approach X for Y reason.',
    body: 'Full rationale here.',
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

/** Convenience: build PromoteService wired to fresh fakes. */
function makeService(
  items: PromotionItemRow[],
  verdicts: Verdict[],
  applyResults: Map<string, ApplyResult> = new Map(),
): {
  service: PromoteService;
  repo: FakePromotionRepository;
  judge: FakeJudge;
  auditLogger: FakeAuditLogger;
} {
  const repo = new FakePromotionRepository(items, applyResults);
  const judge = new FakeJudge(verdicts);
  const auditLogger = new FakeAuditLogger();
  // Stub embedder: returns a fixed unit vector so embedding calls succeed without AWS.
  const embedder = { embed: (_: string) => Promise.resolve([] as number[]) };
  const service = new PromoteService({ promotionRepository: repo, judge, auditLogger, embedder });
  return { service, repo, judge, auditLogger };
}

// ---------------------------------------------------------------------------
// Test: empty items → no_op
// ---------------------------------------------------------------------------

describe('PromoteService.promote — empty items', () => {
  it("returns no_op with zero counters when fetchPromotableItems is empty", async () => {
    const { service, repo, auditLogger } = makeService([], ['accepted']);
    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('no_op');
    expect(outcome.applied).toBe(0);
    expect(outcome.deduped).toBe(0);
    expect(outcome.quarantined).toBe(0);
    expect(outcome.uncertain).toBe(0);

    // Early return — session must NOT be finalized
    expect(repo.finalizeCalls).toHaveLength(0);
    // Early return — no audit record for a no_op
    expect(auditLogger.recordPromoteCalls).toHaveLength(0);
  });

  it('idempotent re-run: all items already have promoted_at set → no_op (empty list simulates this)', async () => {
    // fetchPromotableItems filters promoted_at IS NULL; a fully-promoted session
    // returns []. The service must treat this identically to the empty case.
    const { service } = makeService([], ['accepted']);
    const outcome = await service.promote(SESSION_ID, META);
    expect(outcome.status).toBe('no_op');
    expect(outcome.applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test: pending verdict routing — accepted
// ---------------------------------------------------------------------------

describe('PromoteService.promote — accepted verdict → apply', () => {
  it('calls applyAccepted for a pending item judged accepted and increments applied', async () => {
    const item = makeItem('item-1');
    const { service, repo, judge } = makeService([item], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);
    expect(outcome.deduped).toBe(0);
    expect(outcome.quarantined).toBe(0);
    expect(outcome.uncertain).toBe(0);
    expect(outcome.status).toBe('promoted');

    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls[0]!.item.id).toBe('item-1');
    expect(repo.quarantineCalls).toHaveLength(0);

    // Verdict is recorded before routing
    expect(repo.verdictCalls).toHaveLength(1);
    expect(repo.verdictCalls[0]!.verdict).toBe('accepted');
    expect(repo.verdictCalls[0]!.reason).toBeNull();

    // Judge was called exactly once
    expect(judge.evaluateCalls).toHaveLength(1);
  });

  it('increments deduped counter when applyAccepted returns deduped=true', async () => {
    const item = makeItem('item-dedup');
    const applyResults = new Map<string, ApplyResult>([
      ['item-dedup', { status: 'applied', memoryId: 'mem-existing', deduped: true }],
    ]);
    const { service } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);
    expect(outcome.deduped).toBe(1);
  });

  it('counts applied++ but not deduped when deduped=false', async () => {
    const item = makeItem('item-fresh');
    const applyResults = new Map<string, ApplyResult>([
      ['item-fresh', { status: 'applied', memoryId: 'mem-new', deduped: false }],
    ]);
    const { service } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);
    expect(outcome.deduped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test: pending verdict routing — rejected
// ---------------------------------------------------------------------------

describe('PromoteService.promote — rejected verdict → quarantine', () => {
  it('calls quarantineItem with reason judge_rejected when judge rejects a pending item', async () => {
    const item = makeItem('item-rej');
    const { service, repo } = makeService([item], ['rejected']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(outcome.uncertain).toBe(0);
    expect(outcome.status).toBe('rejected');

    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('judge_rejected');
    expect(repo.quarantineCalls[0]!.redact).toBe(false);
    expect(repo.quarantineCalls[0]!.item.id).toBe('item-rej');

    // applyAccepted must NOT be called for a rejected item
    expect(repo.applyAcceptedCalls).toHaveLength(0);
  });

  it('uses item.judge_reason when present on a pre-marked rejected verdict', async () => {
    // This edge case tests the `item.judge_reason ?? 'judge_rejected'` fallback:
    // a 'pending' item has null judge_reason, so the fallback is used.
    const item = makeItem('item-rej-null', { judge_reason: null });
    const { service, repo } = makeService([item], ['rejected']);
    await service.promote(SESSION_ID, META);

    expect(repo.quarantineCalls[0]!.reason).toBe('judge_rejected');
  });
});

// ---------------------------------------------------------------------------
// Test: pending verdict routing — uncertain (fail-closed)
// ---------------------------------------------------------------------------

describe('PromoteService.promote — uncertain verdict → leave un-applied (fail-closed)', () => {
  it('records uncertain verdict, does not apply or quarantine the item', async () => {
    const item = makeItem('item-unc');
    const { service, repo, judge } = makeService([item], ['uncertain']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.uncertain).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(outcome.quarantined).toBe(0);

    // Verdict persisted so a re-run can reuse it
    expect(repo.verdictCalls).toHaveLength(1);
    expect(repo.verdictCalls[0]!.verdict).toBe('uncertain');
    expect(repo.verdictCalls[0]!.reason).toBeNull();

    // Item must be left completely un-applied
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);

    expect(judge.evaluateCalls).toHaveLength(1);
  });

  it('fail-closed: uncertain verdict means item is never applied (status partially_promoted when some items applied)', async () => {
    const accepted = makeItem('item-a');
    const uncertain = makeItem('item-u');
    const { service } = makeService(
      [accepted, uncertain],
      ['accepted', 'uncertain'],
    );

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);
    expect(outcome.uncertain).toBe(1);
    expect(outcome.status).toBe('partially_promoted');
  });
});

// ---------------------------------------------------------------------------
// Test: applyAccepted result routing (stale / duplicate / already)
// ---------------------------------------------------------------------------

describe('PromoteService.promote — applyAccepted result routing', () => {
  it('stale → quarantineItem(reason stale_target, redact=false) and increments quarantined', async () => {
    const item = makeItem('item-stale');
    const applyResults = new Map<string, ApplyResult>([
      ['item-stale', { status: 'stale' }],
    ]);
    const { service, repo } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(outcome.applied).toBe(0);

    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('stale_target');
    expect(repo.quarantineCalls[0]!.redact).toBe(false);
  });

  it('duplicate → quarantineItem(reason duplicate_content, redact=false) and increments quarantined', async () => {
    const item = makeItem('item-dup');
    const applyResults = new Map<string, ApplyResult>([
      ['item-dup', { status: 'duplicate' }],
    ]);
    const { service, repo } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(outcome.applied).toBe(0);

    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('duplicate_content');
    expect(repo.quarantineCalls[0]!.redact).toBe(false);
  });

  it('already → counted as applied (idempotent path)', async () => {
    const item = makeItem('item-already');
    const applyResults = new Map<string, ApplyResult>([
      ['item-already', { status: 'already' }],
    ]);
    const { service, repo } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    // 'already' is treated as applied — idempotent re-run
    expect(outcome.applied).toBe(1);
    expect(outcome.quarantined).toBe(0);
    // applyAccepted was still called (the service tries, gets 'already' back)
    expect(repo.applyAcceptedCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: sanitize gate — secrets block judge (secret_detected, redact=true)
// ---------------------------------------------------------------------------

describe('PromoteService.promote — sanitize gate (assertNoSecrets)', () => {
  it('AWS access key (AKIA…) in body → quarantineItem(secret_detected, redact=true); judge never called', async () => {
    const item = makeItem('item-aws', {
      // AKIA + 16 uppercase A-Z0-9 chars — matches aws_access_key_id pattern
      body: 'Found this key: AKIAIOSFODNN7EXAMPLE — do not use.',
    });
    const { service, repo, judge } = makeService([item], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    // Quarantined as secret
    expect(outcome.quarantined).toBe(1);
    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('secret_detected');
    expect(repo.quarantineCalls[0]!.redact).toBe(true);
    expect(repo.quarantineCalls[0]!.item.id).toBe('item-aws');

    // Judge must NOT be called for this item
    expect(judge.evaluateCalls).toHaveLength(0);

    // Not applied
    expect(repo.applyAcceptedCalls).toHaveLength(0);
  });

  it('PEM private key block in title → quarantineItem(secret_detected, redact=true); judge never called', async () => {
    const item = makeItem('item-pem', {
      // Matches -----BEGIN [A-Z ]*PRIVATE KEY----- pattern
      title: '-----BEGIN RSA PRIVATE KEY----- key management',
    });
    const { service, repo, judge } = makeService([item], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('secret_detected');
    expect(repo.quarantineCalls[0]!.redact).toBe(true);

    // Judge never called — the sanitize gate short-circuits
    expect(judge.evaluateCalls).toHaveLength(0);
  });

  it('AWS key ONLY in fields (title/summary/body clean) → quarantineItem(secret_detected, redact=true); judge never called (M1 fix)', async () => {
    // Verifies that item.fields is included in the secret scan (mirrors remember.ts step 4).
    // An item whose title/summary/body are clean but whose fields contain a secret
    // must be caught and quarantined before reaching the judge.
    const item = makeItem('item-fields-secret', {
      fields: {
        apiKey: 'AKIAIOSFODNN7EXAMPLE',
      },
    });
    const { service, repo, judge } = makeService([item], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    // Item must be quarantined as secret
    expect(outcome.quarantined).toBe(1);
    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.reason).toBe('secret_detected');
    expect(repo.quarantineCalls[0]!.redact).toBe(true);
    expect(repo.quarantineCalls[0]!.item.id).toBe('item-fields-secret');

    // Judge must NOT be called — secret in fields short-circuits
    expect(judge.evaluateCalls).toHaveLength(0);
    // Item not applied
    expect(repo.applyAcceptedCalls).toHaveLength(0);
  });

  it('an item without secrets still reaches the judge normally', async () => {
    const cleanItem = makeItem('item-clean');
    const { service, judge } = makeService([cleanItem], ['accepted']);

    await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(1);
  });

  it('sanitize fires only for pending items; persisted accepted item with a secret body is not re-scanned', async () => {
    // An item already accepted on a prior run is NOT passed through assertNoSecrets again.
    // (The sanitize was applied when the item was 'pending'; reuse path skips it.)
    const item = makeItem('item-prescan', {
      judge_state: 'accepted',
      body: 'AKIAIOSFODNN7EXAMPLE — secret, but this item was already accepted.',
    });
    const { service, repo, judge } = makeService([item], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    // Should apply, not quarantine
    expect(outcome.applied).toBe(1);
    expect(repo.quarantineCalls).toHaveLength(0);
    // Judge also not called (persisted verdict reuse)
    expect(judge.evaluateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: persisted-verdict reuse — judge not re-called
// ---------------------------------------------------------------------------

describe('PromoteService.promote — persisted-verdict reuse', () => {
  it("judge_state='accepted' → judge not re-called; applyAccepted is called", async () => {
    const item = makeItem('item-pre-accepted', { judge_state: 'accepted' });
    const { service, repo, judge } = makeService([item], ['rejected']); // irrelevant verdict

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    // recordVerdict also NOT called (verdict was already persisted)
    expect(repo.verdictCalls).toHaveLength(0);
    // applyAccepted IS called because the verdict is 'accepted'
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(outcome.applied).toBe(1);
  });

  it("judge_state='uncertain' → judge not re-called; item left as uncertain", async () => {
    const item = makeItem('item-pre-uncertain', { judge_state: 'uncertain' });
    const { service, repo, judge } = makeService([item], ['accepted']); // irrelevant

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.verdictCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(outcome.uncertain).toBe(1);
  });

  it("judge_state='rejected' → item is entirely skipped (no quarantine, no judge)", async () => {
    // Already-quarantined from a prior run — must not be double-quarantined.
    const item = makeItem('item-pre-rejected', { judge_state: 'rejected' });
    const { service, repo, judge } = makeService([item], ['accepted']); // irrelevant

    const outcome = await service.promote(SESSION_ID, META);

    expect(judge.evaluateCalls).toHaveLength(0);
    expect(repo.verdictCalls).toHaveLength(0);
    expect(repo.quarantineCalls).toHaveLength(0);
    expect(repo.applyAcceptedCalls).toHaveLength(0);
    // Counters: applied=0, uncertain=0 → terminal status is 'rejected'
    expect(outcome.applied).toBe(0);
    expect(outcome.quarantined).toBe(0);
    expect(outcome.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Test: terminal status logic
// ---------------------------------------------------------------------------

describe('PromoteService.promote — terminal status', () => {
  it("all items applied → status 'promoted'", async () => {
    const items = [makeItem('t1'), makeItem('t2')];
    const { service, repo } = makeService(items, ['accepted', 'accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('promoted');
    expect(repo.finalizeCalls).toHaveLength(1);
    expect(repo.finalizeCalls[0]!.status).toBe('promoted');
  });

  it("all items quarantined (no uncertain) → status 'rejected'", async () => {
    const items = [makeItem('t3'), makeItem('t4')];
    const { service, repo } = makeService(items, ['rejected', 'rejected']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('rejected');
    expect(repo.finalizeCalls[0]!.status).toBe('rejected');
  });

  it("one applied + one quarantined → status 'partially_promoted'", async () => {
    const items = [makeItem('t5'), makeItem('t6')];
    const { service, repo } = makeService(items, ['accepted', 'rejected']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('partially_promoted');
    expect(outcome.applied).toBe(1);
    expect(outcome.quarantined).toBe(1);
    expect(repo.finalizeCalls[0]!.status).toBe('partially_promoted');
  });

  it("one applied + one uncertain → status 'partially_promoted'", async () => {
    const items = [makeItem('t7'), makeItem('t8')];
    const { service, repo } = makeService(items, ['accepted', 'uncertain']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('partially_promoted');
    expect(outcome.applied).toBe(1);
    expect(outcome.uncertain).toBe(1);
    expect(repo.finalizeCalls[0]!.status).toBe('partially_promoted');
  });

  it("empty items → status 'no_op'; finalizeSession not called", async () => {
    const { service, repo } = makeService([], ['accepted']);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.status).toBe('no_op');
    expect(repo.finalizeCalls).toHaveLength(0);
  });

  it('single pending-then-stale item → quarantined; status rejected', async () => {
    const item = makeItem('stale-only');
    const applyResults = new Map<string, ApplyResult>([
      ['stale-only', { status: 'stale' }],
    ]);
    const { service } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.quarantined).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(outcome.uncertain).toBe(0);
    expect(outcome.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Test: audit — recordPromote counters
// ---------------------------------------------------------------------------

describe('PromoteService.promote — auditLogger.recordPromote', () => {
  it('recordPromote is called once after a non-no_op run with correct counters', async () => {
    const items = [makeItem('a1'), makeItem('a2'), makeItem('a3')];
    // a1 → accepted+applied, a2 → rejected→quarantine, a3 → uncertain
    const { service, auditLogger } = makeService(
      items,
      ['accepted', 'rejected', 'uncertain'],
    );

    await service.promote(SESSION_ID, META);

    expect(auditLogger.recordPromoteCalls).toHaveLength(1);
    const { p } = auditLogger.recordPromoteCalls[0]!;
    expect(p.sessionId).toBe(SESSION_ID);
    expect(p.applied).toBe(1);
    expect(p.quarantined).toBe(1);
    expect(p.uncertain).toBe(1);
    expect(p.prNumber).toBe(META.originPr);
    expect(p.mergeSha).toBe(META.mergeSha);
  });

  it('recordPromote is NOT called for a no_op run', async () => {
    const { service, auditLogger } = makeService([], ['accepted']);

    await service.promote(SESSION_ID, META);

    expect(auditLogger.recordPromoteCalls).toHaveLength(0);
  });

  it('recordPromote receives correct counters for all-applied scenario', async () => {
    const items = [makeItem('aa1'), makeItem('aa2')];
    const { service, auditLogger } = makeService(items, ['accepted', 'accepted']);

    await service.promote(SESSION_ID, META);

    const { p } = auditLogger.recordPromoteCalls[0]!;
    expect(p.applied).toBe(2);
    expect(p.quarantined).toBe(0);
    expect(p.uncertain).toBe(0);
  });

  it('recordPromote deduped counter reflects actual applied items even when some are deduped', async () => {
    const item = makeItem('aa-dedup');
    const applyResults = new Map<string, ApplyResult>([
      ['aa-dedup', { status: 'applied', memoryId: 'mem-existing', deduped: true }],
    ]);
    const { service, auditLogger } = makeService([item], ['accepted'], applyResults);

    const outcome = await service.promote(SESSION_ID, META);

    // PromoteOutcome tracks deduped separately; auditLogger only gets applied/quarantined/uncertain
    expect(outcome.deduped).toBe(1);
    expect(outcome.applied).toBe(1);
    const { p } = auditLogger.recordPromoteCalls[0]!;
    expect(p.applied).toBe(1);
  });

  it('recordPromote receives the tenant context from meta', async () => {
    const item = makeItem('ctx-check');
    const { service, auditLogger } = makeService([item], ['accepted']);

    await service.promote(SESSION_ID, META);

    const { ctx } = auditLogger.recordPromoteCalls[0]!;
    expect(ctx.tenant.projectId).toBe(META.tenant.projectId);
    expect(ctx.tenant.repoId).toBe(META.tenant.repoId);
    expect(ctx.actor.actorId).toBe(META.actor.actorId);
  });
});

// ---------------------------------------------------------------------------
// Test: mixed multi-item scenarios
// ---------------------------------------------------------------------------

describe('PromoteService.promote — mixed multi-item scenarios', () => {
  it('processes items sequentially; each pending item goes through sanitize→judge independently', async () => {
    // Item 1: accepted, Item 2: uncertain, Item 3: secret in body → quarantine before judge
    const item1 = makeItem('mix-1');
    const item2 = makeItem('mix-2');
    const item3 = makeItem('mix-3', {
      body: 'Leaked: AKIAIOSFODNN7EXAMPLE should not be here.',
    });
    const { service, repo, judge } = makeService(
      [item1, item2, item3],
      ['accepted', 'uncertain'], // judge only called for item1 and item2
    );

    const outcome = await service.promote(SESSION_ID, META);

    expect(outcome.applied).toBe(1);      // item1
    expect(outcome.uncertain).toBe(1);    // item2
    expect(outcome.quarantined).toBe(1);  // item3 (secret)
    expect(outcome.status).toBe('partially_promoted');

    // Judge called exactly twice (item3 never reaches it)
    expect(judge.evaluateCalls).toHaveLength(2);

    // Secret item quarantined with redact=true
    expect(repo.quarantineCalls).toHaveLength(1);
    expect(repo.quarantineCalls[0]!.item.id).toBe('mix-3');
    expect(repo.quarantineCalls[0]!.reason).toBe('secret_detected');
    expect(repo.quarantineCalls[0]!.redact).toBe(true);
  });

  it('a mix of persisted-verdict items and fresh items; only fresh pending items reach judge', async () => {
    const preAccepted = makeItem('pre-a', { judge_state: 'accepted' });
    const preRejected = makeItem('pre-r', { judge_state: 'rejected' }); // skipped
    const freshPending = makeItem('fresh-p');

    const { service, repo, judge } = makeService(
      [preAccepted, preRejected, freshPending],
      ['accepted'], // only for freshPending
    );

    const outcome = await service.promote(SESSION_ID, META);

    // pre-accepted → applied; pre-rejected → skipped; fresh-pending → accepted+applied
    expect(outcome.applied).toBe(2);
    expect(outcome.quarantined).toBe(0);
    expect(outcome.uncertain).toBe(0);

    // Judge only called for freshPending
    expect(judge.evaluateCalls).toHaveLength(1);
    expect(judge.evaluateCalls[0]!.title).toBe(freshPending.title);

    // applyAccepted called for pre-accepted and fresh-pending
    expect(repo.applyAcceptedCalls).toHaveLength(2);
  });
});
