/**
 * Shared fakes for the PromoteService unit tests (promoteService, promoteVerdict,
 * promoteEmbedding). DB-free and deterministic.
 *
 *  - FakePromotionRepository: STATEFUL — recordDecision / persistMasked /
 *    quarantineItem / applyAccepted mutate the seeded rows, so running promote()
 *    twice on the same repo exercises the real idempotency path.
 *  - FakeJudge: scripted JudgeResult (or Error) per evaluate() call.
 *  - FakeNotifier, FakeAuditLogger: capture calls.
 *  - makeItem / makeService: fixtures with safe defaults.
 */

import { PromoteService } from '../../src/promote/promoteService.js';
import type { PromoteMeta } from '../../src/promote/promoteService.js';
import type { RoutingConfig } from '../../src/promote/routing.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
  ApplyResult,
  PersistedDecision,
  QuarantineInput,
  SanitizeFlags,
} from '../../src/db/promotionRepository.js';
import type {
  Judge,
  JudgeItem,
  JudgeContextItem,
  JudgeResult,
  JudgeCriterion,
} from '../../src/judge/judge.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type { MemoryType } from '../../src/contracts/memory.js';
import type { Notifier, NotifyEvent } from '../../src/notify/notifier.js';
import type {
  AuditLogger,
  TenantContext,
  RequestContext,
  ToolName,
} from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

type MaskedContent = Pick<PromotionItemRow, 'title' | 'summary' | 'body' | 'fields'>;

export class FakePromotionRepository implements PromotionRepository {
  readonly rows = new Map<string, PromotionItemRow>();

  readonly decisionCalls: Array<{ itemId: string; d: PersistedDecision; flags: SanitizeFlags }> =
    [];
  readonly quarantineCalls: Array<{
    item: PromotionItemRow;
    ctx: ApplyContext;
    q: QuarantineInput;
  }> = [];
  readonly persistMaskedCalls: Array<{
    itemId: string;
    content: MaskedContent;
    contentHash: string;
    flags: SanitizeFlags;
  }> = [];
  readonly contextCalls: Array<{
    projectId: string;
    text: { title: string; summary: string };
    excludeMemoryId: string | null;
  }> = [];
  readonly applyAcceptedCalls: Array<{
    item: PromotionItemRow;
    ctx: ApplyContext;
    embedding: number[] | null;
    mandatoryTypes: ReadonlySet<MemoryType>;
  }> = [];
  readonly finalizeCalls: Array<{
    sessionId: string;
    status: 'promoted' | 'rejected' | 'partially_promoted';
  }> = [];

  /** Scripted judge context (returned by findJudgeContext). */
  context: JudgeContextItem[] = [];
  /** When set, findJudgeContext rejects with it. */
  contextError: Error | null = null;
  /** Item ids for which persistMasked reports a UNIQUE(session_id, content_hash) clash. */
  readonly hashConflictIds = new Set<string>();

  constructor(
    items: PromotionItemRow[] = [],
    private readonly applyResults: Map<string, ApplyResult> = new Map(),
  ) {
    for (const item of items) this.rows.set(item.id, { ...item });
  }

  findOpenSessionId(_tenant: TenantContext): Promise<string | null> {
    return Promise.resolve('test-session');
  }

  fetchPromotableItems(_sessionId: string, _projectId: string): Promise<PromotionItemRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.promoted_at === null).map((r) => ({ ...r })),
    );
  }

  findJudgeContext(
    projectId: string,
    text: { title: string; summary: string },
    excludeMemoryId: string | null,
  ): Promise<JudgeContextItem[]> {
    this.contextCalls.push({ projectId, text, excludeMemoryId });
    if (this.contextError) return Promise.reject(this.contextError);
    return Promise.resolve(this.context);
  }

  persistMasked(
    itemId: string,
    content: MaskedContent,
    contentHash: string,
    flags: SanitizeFlags,
  ): Promise<'ok' | 'hash_conflict'> {
    this.persistMaskedCalls.push({ itemId, content, contentHash, flags });
    if (this.hashConflictIds.has(itemId)) return Promise.resolve('hash_conflict');
    const row = this.rows.get(itemId);
    if (row) {
      Object.assign(row, content, { content_hash: contentHash, sanitize_flags: flags });
    }
    return Promise.resolve('ok');
  }

  recordDecision(itemId: string, d: PersistedDecision, flags: SanitizeFlags): Promise<void> {
    this.decisionCalls.push({ itemId, d, flags });
    const row = this.rows.get(itemId);
    if (row) {
      Object.assign(row, {
        judge_state: d.verdict,
        judge_reason: d.reason,
        judge_criterion: d.criterion,
        judge_confidence: d.confidence,
        related_memory_id: d.relatedMemoryId,
        mandatory_review: d.mandatoryReview,
        sanitize_flags: flags,
      });
    }
    return Promise.resolve();
  }

  applyAccepted(
    item: PromotionItemRow,
    ctx: ApplyContext,
    embedding: number[] | null,
    mandatoryTypes: ReadonlySet<MemoryType>,
  ): Promise<ApplyResult> {
    this.applyAcceptedCalls.push({ item, ctx, embedding, mandatoryTypes });
    const result: ApplyResult = this.applyResults.get(item.id) ?? {
      status: 'applied',
      memoryId: `mem-${item.id}`,
      deduped: false,
    };
    const row = this.rows.get(item.id);
    if (row && (result.status === 'applied' || result.status === 'already')) {
      row.promoted_at = new Date();
      row.promoted_memory_id = result.status === 'applied' ? result.memoryId : null;
    }
    return Promise.resolve(result);
  }

  quarantineItem(item: PromotionItemRow, ctx: ApplyContext, q: QuarantineInput): Promise<void> {
    this.quarantineCalls.push({ item, ctx, q });
    const row = this.rows.get(item.id);
    if (row) {
      // Mirrors the repository: a non-redacted judge rejection keeps the
      // justification on the staging row; everything else stores the code.
      const keepJustification = !q.redact && q.decision?.verdict === 'rejected';
      Object.assign(row, {
        judge_state: 'rejected',
        judge_reason: keepJustification ? q.decision!.reason : q.reason,
        judge_criterion: q.decision?.criterion ?? null,
        judge_confidence: q.decision?.confidence ?? null,
        related_memory_id: q.decision?.relatedMemoryId ?? null,
        sanitize_flags: q.sanitizeFlags,
      });
    }
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

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export function accepted(confidence = 0.9): JudgeResult {
  return {
    verdict: 'accepted',
    criterion: 'confidence',
    confidence,
    reason: 'looks good',
    relatedMemoryId: null,
  };
}

export function rejected(
  criterion: JudgeCriterion,
  relatedMemoryId: string | null = null,
  confidence = 0.95,
): JudgeResult {
  return {
    verdict: 'rejected',
    criterion,
    confidence,
    reason: `rejected: ${criterion}`,
    relatedMemoryId,
  };
}

export function uncertain(
  criterion: JudgeCriterion,
  relatedMemoryId: string | null = null,
  confidence = 0.7,
): JudgeResult {
  return {
    verdict: 'uncertain',
    criterion,
    confidence,
    reason: `uncertain: ${criterion}`,
    relatedMemoryId,
  };
}

/** Scripted judge: the Nth call returns results[N-1]; the last entry repeats. An Error rejects. */
export class FakeJudge implements Judge {
  readonly evaluateCalls: Array<{ item: JudgeItem; context: readonly JudgeContextItem[] }> = [];

  constructor(private readonly results: Array<JudgeResult | Error> = [accepted()]) {}

  evaluate(item: JudgeItem, context: readonly JudgeContextItem[]): Promise<JudgeResult> {
    this.evaluateCalls.push({ item, context });
    const idx = Math.min(this.evaluateCalls.length - 1, this.results.length - 1);
    const r = this.results[idx]!;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

// ---------------------------------------------------------------------------
// Notifier + audit
// ---------------------------------------------------------------------------

export class FakeNotifier implements Notifier {
  readonly events: Array<{ projectId: string; event: NotifyEvent }> = [];

  notify(projectId: string, event: NotifyEvent): Promise<void> {
    this.events.push({ projectId, event });
    return Promise.resolve();
  }

  ofType(type: NotifyEvent['type']): NotifyEvent[] {
    return this.events.filter((e) => e.event.type === type).map((e) => e.event);
  }
}

export interface RecordPromoteParams {
  sessionId: string;
  applied: number;
  quarantined: number;
  uncertain: number;
  prNumber: number | null;
  mergeSha: string | null;
}

export class FakeAuditLogger implements AuditLogger {
  readonly recordPromoteCalls: Array<{ ctx: RequestContext; p: RecordPromoteParams }> = [];

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

  recordPromote(ctx: RequestContext, p: RecordPromoteParams): Promise<void> {
    this.recordPromoteCalls.push({ ctx, p });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const SESSION_ID = 'sess-test-001';

export const META: PromoteMeta = {
  tenant: { projectId: 'proj-1', repoId: 'repo-1', branch: 'main' },
  actor: { actorId: 'ci-actor', roles: ['service_agent'] },
  originBranch: 'main',
  originPr: 42,
  mergeSha: 'abc123sha',
};

export const DEFAULT_ROUTING: RoutingConfig = {
  confidenceThreshold: 0.8,
  mandatoryReviewTypes: new Set(['decision', 'constraint', 'domain_rule']),
};

/**
 * Builds a PromotionItemRow with safe defaults. Default type is `pattern`
 * (NOT a default mandatory type) so an accepted item is applied.
 */
export function makeItem(
  id: string,
  overrides: Partial<Omit<PromotionItemRow, 'id'>> = {},
): PromotionItemRow {
  return {
    id,
    op: 'add',
    type: 'pattern',
    title: 'Repository pattern for pg access',
    summary: 'Every DB seam is a class over pg.Pool with SQL constants.',
    body: 'Full rationale here: see src/db/promotionRepository.ts for the shape.',
    fields: {},
    content_hash: `hash-${id}`,
    target_memory_id: null,
    target_revision: null,
    target_type: null,
    judge_state: 'pending',
    judge_reason: null,
    judge_criterion: null,
    judge_confidence: null,
    related_memory_id: null,
    mandatory_review: false,
    sanitize_flags: {},
    author_identity: 'test-author',
    promoted_at: null,
    promoted_memory_id: null,
    ...overrides,
  };
}

export interface MakeServiceOptions {
  results?: Array<JudgeResult | Error>;
  applyResults?: Map<string, ApplyResult>;
  routing?: RoutingConfig;
  embedder?: Embedder;
}

export function makeService(items: PromotionItemRow[], opts: MakeServiceOptions = {}) {
  const repo = new FakePromotionRepository(items, opts.applyResults);
  const judge = new FakeJudge(opts.results);
  const auditLogger = new FakeAuditLogger();
  const notifier = new FakeNotifier();
  const embedder: Embedder = opts.embedder ?? { embed: () => Promise.resolve([] as number[]) };
  const service = new PromoteService({
    promotionRepository: repo,
    judge,
    auditLogger,
    embedder,
    notifier,
    routing: opts.routing ?? DEFAULT_ROUTING,
  });
  return { service, repo, judge, auditLogger, notifier };
}
