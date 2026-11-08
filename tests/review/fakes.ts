import type {
  MemoryRefRow,
  ReviewItemRow,
  ReviewQueueRepository,
} from '../../src/db/reviewQueueRepository.js';
import type {
  ApprovedReview,
  ReviewApproveInput,
  ReviewApproveResult,
  ReviewRejectInput,
} from '../../src/db/promotionRepository.js';
import type { TxnAudit } from '../../src/db/authRepository.js';
import { FAKE_TXN } from '../auth/txnAudit.js';
import type { AdminActor } from '../../src/mcp/context.js';
import type { Embedder } from '../../src/embedder/embedder.js';

export const ACTOR = { userId: 'user-1', actorId: 'sub-1' } as unknown as AdminActor;

export function makeItem(over: Partial<ReviewItemRow> = {}): ReviewItemRow {
  return {
    id: 'item-1',
    op: 'add',
    type: 'decision',
    title: 'T',
    judge_state: 'uncertain',
    judge_criterion: 'confidence',
    judge_confidence: 0.4,
    mandatory_review: false,
    origin_branch: 'feat/x',
    origin_pr: 7,
    author: 'Dev',
    created_at: new Date('2026-01-02T03:04:05Z'),
    summary: 'S',
    body: 'B',
    fields: {},
    content_hash: 'h1',
    target_memory_id: null,
    target_revision: null,
    judge_reason: 'why',
    related_memory_id: null,
    sanitize_flags: {},
    author_identity: 'sub-dev',
    ...over,
  } as ReviewItemRow;
}

export function makeRef(over: Partial<MemoryRefRow> = {}): MemoryRefRow {
  return {
    id: 'mem-1',
    type: 'decision',
    title: 'M',
    summary: 'MS',
    status: 'active',
    current_revision: 3,
    origin_branch: 'main',
    origin_pr: null,
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

export class FakeQueueRepo implements ReviewQueueRepository {
  item: ReviewItemRow | null = null;
  refs: MemoryRefRow[] = [];
  rows: ReviewItemRow[] = [];
  truncated = false;
  async listQueue() {
    return { rows: this.rows, truncated: this.truncated };
  }
  async countQueue() {
    return { pending: 2, uncertain: 1, mandatory: 1, resolvedLast7Days: 5 };
  }
  async findQueuedItem() {
    return this.item;
  }
  async findMemoryRefs(_p: string, ids: string[]) {
    return ids.length === 0 ? [] : this.refs.filter((r) => ids.includes(r.id));
  }
}

export class FakePromotionRepo {
  approveInputs: ReviewApproveInput[] = [];
  rejectInputs: ReviewRejectInput[] = [];
  approveResult: ReviewApproveResult = {
    status: 'approved',
    memoryId: 'mem-9',
    deduped: false,
    rebasedFromRevision: null,
    rebasedToRevision: null,
    relatedSuperseded: false,
  };
  rejectResult: 'rejected' | 'not_found' = 'rejected';
  async approveReviewItem(i: ReviewApproveInput, audit?: TxnAudit<ApprovedReview>) {
    this.approveInputs.push(i);
    if (audit && this.approveResult.status === 'approved') {
      await audit(FAKE_TXN, this.approveResult);
    }
    return this.approveResult;
  }
  async rejectReviewItem(i: ReviewRejectInput, audit?: TxnAudit<'rejected'>) {
    this.rejectInputs.push(i);
    if (audit && this.rejectResult === 'rejected') await audit(FAKE_TXN, 'rejected');
    return this.rejectResult;
  }
}

export class FakeEmbedder implements Embedder {
  calls: string[] = [];
  fail = false;
  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    if (this.fail) throw new Error('boom secret content');
    return [0.1, 0.2];
  }
}
