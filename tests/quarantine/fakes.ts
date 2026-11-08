/** Fakes for the quarantine service tests (C3). */

import type {
  QuarantineDetailRow,
  QuarantineListRow,
  QuarantineRepository,
  QuarantineViewer,
  RestoreClaim,
  RestoreClaimInput,
  RestoreClaimRelease,
} from '../../src/db/quarantineRepository.js';
import type {
  ItemOrigin,
  ItemResult,
  PromoteItemOptions,
  PromoteServiceLike,
} from '../../src/promote/promoteService.js';
import { runItemAudit } from '../auth/txnAudit.js';
import type { QuarantineReasonCode } from '../../src/quarantine/reason.js';

export const ROW: QuarantineListRow = {
  id: '11111111-1111-4111-8111-111111111111',
  reasonCode: 'judge_rejected',
  criterion: 'judge',
  op: 'add',
  type: 'gotcha',
  title: 'Deploy issue',
  excerpt: 'Deploy failed with [REDACTADO]',
  quarantinedAt: new Date('2026-11-01T10:00:00.000Z'),
  daysUntilExpiry: 54,
};

export const DETAIL: QuarantineDetailRow = {
  ...ROW,
  summary: 'Summary',
  body: 'Deploy failed with [REDACTADO]',
  fields: {},
  judgeReason: 'specificity',
  expiresAt: new Date('2026-12-31T10:00:00.000Z'),
  author: 'Dev One',
  originBranch: 'feat/x',
  originPr: 7,
  related: null,
};

export class FakeQuarantineRepository implements QuarantineRepository {
  readonly listCalls: Array<{
    projectId: string;
    v: QuarantineViewer;
    q: { reason: QuarantineReasonCode | null; limit: number };
  }> = [];
  readonly findCalls: Array<{ projectId: string; v: QuarantineViewer; id: string }> = [];
  readonly claimCalls: RestoreClaimInput[] = [];
  purgeResult: Array<{ projectId: string; count: number }> = [];
  claimResult: RestoreClaim = {
    status: 'claimed',
    sessionId: 'sess-restore',
    itemId: 'item-restore',
    repoId: 'repo-1',
    branch: `restore/${ROW.id}`,
    originPr: 7,
  };
  detail: QuarantineDetailRow | null = DETAIL;
  /** author_identity of the seeded row: non-admin viewers only see it when they match. */
  author = 'author-sub';

  private visible(v: QuarantineViewer): boolean {
    return v.isAdmin || v.subject === this.author;
  }

  list(
    projectId: string,
    v: QuarantineViewer,
    q: { reason: QuarantineReasonCode | null; limit: number },
  ) {
    this.listCalls.push({ projectId, v, q });
    return Promise.resolve({ rows: this.visible(v) ? [ROW] : [], truncated: false });
  }

  findVisible(projectId: string, v: QuarantineViewer, id: string) {
    this.findCalls.push({ projectId, v, id });
    return Promise.resolve(this.visible(v) ? this.detail : null);
  }

  claimForRestore(i: RestoreClaimInput): Promise<RestoreClaim> {
    this.claimCalls.push(i);
    return Promise.resolve(this.claimResult);
  }

  readonly releaseCalls: RestoreClaimRelease[] = [];
  /** true = released; an Error makes the release throw. */
  releaseResult: boolean | Error = true;

  releaseRestoreClaim(r: RestoreClaimRelease): Promise<boolean> {
    this.releaseCalls.push(r);
    return this.releaseResult instanceof Error
      ? Promise.reject(this.releaseResult)
      : Promise.resolve(this.releaseResult);
  }

  purgeExpired() {
    return Promise.resolve(this.purgeResult);
  }
}

/** promoteItem scripted with a fixed result (or error). */
export class ScriptedPromoteService implements Pick<PromoteServiceLike, 'promoteItem'> {
  readonly calls: Array<{ sessionId: string; itemId: string; origin: ItemOrigin }> = [];
  constructor(
    public result: ItemResult | Error = { outcome: 'applied', memoryId: 'mem-1', deduped: false },
  ) {}

  async promoteItem(
    sessionId: string,
    itemId: string,
    origin: ItemOrigin,
    opts?: PromoteItemOptions,
  ): Promise<ItemResult> {
    this.calls.push({ sessionId, itemId, origin });
    if (this.result instanceof Error) throw this.result;
    await runItemAudit(this.result, opts);
    return this.result;
  }
}
