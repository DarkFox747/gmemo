/**
 * Fakes for the direct memory management tests (C5, HU-13).
 *
 *  - FakeMemoryAdminRepository: stateful, project-scoped rows + revisions + repos;
 *    list mirrors the SQL (status/type filters, naive q, updated_at DESC id DESC,
 *    the real cursor codec). Records every call.
 *  - RecordingStagingRepository / RecordingPromotionRepository: record inputs;
 *    the promotion fake only has the two capabilities the service may use.
 *  - ScriptedDirectPromote: promoteItem scripted per call (result or Error), records opts.
 *  - makeDirectService: wires a real DirectMemoryService over the fakes.
 */

import type { MemoryType } from '../../src/contracts/memory.js';
import {
  decodeMemoryListCursor,
  encodeMemoryListCursor,
  REVISIONS_LIMIT,
} from '../../src/db/memoryAdminRepository.js';
import type {
  MemoryAdminRepository,
  MemoryDetailRow,
  MemoryListFilter,
  MemoryListRow,
  MemoryRevisionRow,
  MemoryStatus,
} from '../../src/db/memoryAdminRepository.js';
import type { SingleItemSessionInput } from '../../src/db/stagingRepository.js';
import type { MemoryRefRow } from '../../src/db/reviewQueueRepository.js';
import type { JudgeContextItem } from '../../src/judge/judge.js';
import type {
  ItemOrigin,
  ItemResult,
  PromoteItemOptions,
} from '../../src/promote/promoteService.js';
import type { RoutingConfig } from '../../src/promote/routing.js';
import { DirectMemoryService } from '../../src/memory/directMemoryService.js';
import { FakeJudge, accepted } from '../promote/fakes.js';
import type { JudgeResult } from '../../src/judge/judge.js';
import { FakeQuarantineRepository } from '../quarantine/fakes.js';

export const P = '00000000-0000-0000-0000-0000000000a1';
export const Q = '00000000-0000-0000-0000-0000000000b1';
export const REPO_1 = '00000000-0000-4000-8000-0000000000a1';
export const REPO_2 = '00000000-0000-4000-8000-0000000000a2';
export const REPO_FOREIGN = '00000000-0000-4000-8000-0000000000b9';

export interface FakeAdminMemory extends MemoryDetailRow {
  projectId: string;
}

let seq = 0;

/** A detail row with defaults; ids are valid UUIDs; updated_at has microsecond-free ms. */
export function makeAdminMemory(
  p: Partial<FakeAdminMemory> & { projectId: string },
): FakeAdminMemory {
  seq += 1;
  const id = `00000000-0000-4000-9000-${seq.toString().padStart(12, '0')}`;
  return {
    id,
    type: 'gotcha',
    title: `Memory ${seq}`,
    summary: `Summary ${seq}`,
    body: `Body ${seq}`,
    fields: {},
    status: 'active',
    current_revision: 1,
    provenance: 'pr_reviewed',
    author: 'Dev',
    approved_by: null,
    approver: null,
    repo_id: REPO_1,
    repo_slug: 'org/repo',
    origin_branch: 'main',
    origin_pr: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    revalidate_at: null,
    retired_reason: null,
    ...p,
  };
}

/** SQL's microsecond key for a JS date (the fake's dates have no sub-ms part). */
function updatedKey(d: Date): string {
  return d.toISOString().replace('Z', '000Z');
}

export class FakeMemoryAdminRepository implements MemoryAdminRepository {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly revisions = new Map<string, MemoryRevisionRow[]>();
  /** Repos by project, in creation order. */
  readonly repos = new Map<string, string[]>([
    [P, [REPO_1, REPO_2]],
    [Q, [REPO_FOREIGN]],
  ]);

  constructor(readonly memories: FakeAdminMemory[] = []) {}

  async listMemories(
    projectId: string,
    f: MemoryListFilter,
  ): Promise<{ rows: MemoryListRow[]; nextCursor: string | null }> {
    this.calls.push({ method: 'listMemories', args: [projectId, f] });
    const cursor = f.cursor === null ? null : decodeMemoryListCursor(f.cursor);
    const terms = f.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const matching = this.memories
      .filter((m) => m.projectId === projectId && m.status === f.status)
      .filter((m) => f.type === null || m.type === f.type)
      .filter((m) => {
        const text = `${m.title} ${m.summary} ${m.body}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      })
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.id.localeCompare(a.id))
      .filter((m) => {
        if (!cursor) return true;
        const key = updatedKey(m.updated_at);
        return key < cursor.updatedKey || (key === cursor.updatedKey && m.id < cursor.id);
      });
    const kept = matching.slice(0, f.limit);
    const last = kept[kept.length - 1];
    const nextCursor =
      matching.length > f.limit && last
        ? encodeMemoryListCursor({ updatedKey: updatedKey(last.updated_at), id: last.id })
        : null;
    return {
      rows: kept.map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        summary: m.summary,
        status: m.status,
        current_revision: m.current_revision,
        provenance: m.provenance,
        origin_branch: m.origin_branch,
        origin_pr: m.origin_pr,
        revalidate_at: m.revalidate_at,
        updated_at: m.updated_at,
      })),
      nextCursor,
    };
  }

  async findMemory(projectId: string, memoryId: string): Promise<MemoryDetailRow | null> {
    this.calls.push({ method: 'findMemory', args: [projectId, memoryId] });
    const m = this.memories.find((r) => r.id === memoryId && r.projectId === projectId);
    if (!m) return null;
    const { projectId: _p, ...row } = m;
    return row;
  }

  async listRevisions(
    projectId: string,
    memoryId: string,
  ): Promise<{ rows: MemoryRevisionRow[]; truncated: boolean }> {
    this.calls.push({ method: 'listRevisions', args: [projectId, memoryId] });
    const owned = this.memories.some((r) => r.id === memoryId && r.projectId === projectId);
    const all = owned ? [...(this.revisions.get(memoryId) ?? [])] : [];
    all.sort((a, b) => b.revision_no - a.revision_no);
    return { rows: all.slice(0, REVISIONS_LIMIT), truncated: all.length > REVISIONS_LIMIT };
  }

  async findProjectRepoId(projectId: string, repoId: string | null): Promise<string | null> {
    this.calls.push({ method: 'findProjectRepoId', args: [projectId, repoId] });
    const repos = this.repos.get(projectId) ?? [];
    if (repoId === null) return repos[0] ?? null;
    return repos.includes(repoId) ? repoId : null;
  }

  /** findMemoryRefs over the same rows (C2 review-queue seam). */
  async findMemoryRefs(projectId: string, ids: string[]): Promise<MemoryRefRow[]> {
    this.calls.push({ method: 'findMemoryRefs', args: [projectId, ids] });
    return this.memories
      .filter((m) => m.projectId === projectId && ids.includes(m.id))
      .map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        summary: m.summary,
        status: m.status as MemoryRefRow['status'],
        current_revision: m.current_revision,
        origin_branch: m.origin_branch,
        origin_pr: m.origin_pr,
        updated_at: m.updated_at,
      }));
  }

  addRevision(memoryId: string, r: Partial<MemoryRevisionRow> & { revision_no: number }): void {
    const list = this.revisions.get(memoryId) ?? [];
    list.push({
      op: 'add',
      type: 'gotcha' as MemoryType,
      title: 't',
      summary: 's',
      body: 'b',
      fields: {},
      author: 'Dev',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      ...r,
    });
    this.revisions.set(memoryId, list);
  }
}

export class RecordingStagingRepository {
  readonly calls: SingleItemSessionInput[] = [];
  error: Error | null = null;

  createSingleItemSession(
    i: SingleItemSessionInput,
  ): Promise<{ sessionId: string; itemId: string }> {
    this.calls.push(i);
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ sessionId: i.sessionId, itemId: 'item-direct-1' });
  }
}

export class RecordingPromotionRepository {
  readonly contextCalls: Array<{
    projectId: string;
    text: { title: string; summary: string };
    excludeMemoryId: string | null;
  }> = [];
  readonly abandonCalls: Array<{ sessionId: string; projectId: string }> = [];
  context: JudgeContextItem[] = [];
  /** When set, findJudgeContext rejects with it. */
  contextError: Error | null = null;
  abandonError: Error | null = null;

  findJudgeContext(
    projectId: string,
    text: { title: string; summary: string },
    excludeMemoryId: string | null,
  ): Promise<JudgeContextItem[]> {
    this.contextCalls.push({ projectId, text, excludeMemoryId });
    if (this.contextError) return Promise.reject(this.contextError);
    return Promise.resolve(this.context);
  }

  abandonOpenSession(
    sessionId: string,
    projectId: string,
  ): Promise<{ abandoned: boolean; discarded: number }> {
    this.abandonCalls.push({ sessionId, projectId });
    if (this.abandonError) return Promise.reject(this.abandonError);
    return Promise.resolve({ abandoned: true, discarded: 1 });
  }
}

export class ScriptedDirectPromote {
  readonly calls: Array<{
    sessionId: string;
    itemId: string;
    origin: ItemOrigin;
    opts: PromoteItemOptions | undefined;
  }> = [];

  constructor(
    public result: ItemResult | Error = { outcome: 'applied', memoryId: null, deduped: false },
  ) {}

  promoteItem(
    sessionId: string,
    itemId: string,
    origin: ItemOrigin,
    opts?: PromoteItemOptions,
  ): Promise<ItemResult> {
    this.calls.push({ sessionId, itemId, origin, opts });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

export const DIRECT_ROUTING: RoutingConfig = {
  confidenceThreshold: 0.8,
  mandatoryReviewTypes: new Set<MemoryType>(['decision', 'constraint', 'domain_rule']),
};

export interface DirectKit {
  service: DirectMemoryService;
  adminRepo: FakeMemoryAdminRepository;
  staging: RecordingStagingRepository;
  promotion: RecordingPromotionRepository;
  promote: ScriptedDirectPromote;
  quarantine: FakeQuarantineRepository;
  judge: FakeJudge;
}

export function makeDirectService(
  opts: { memories?: FakeAdminMemory[]; judgeResults?: Array<JudgeResult | Error> } = {},
): DirectKit {
  const adminRepo = new FakeMemoryAdminRepository(opts.memories ?? []);
  const staging = new RecordingStagingRepository();
  const promotion = new RecordingPromotionRepository();
  const promote = new ScriptedDirectPromote();
  const quarantine = new FakeQuarantineRepository();
  const judge = new FakeJudge(opts.judgeResults ?? [accepted()]);
  const service = new DirectMemoryService({
    memoryAdminRepository: adminRepo,
    stagingRepository: staging,
    promotionRepository: promotion,
    promoteService: promote,
    reviewQueueRepository: adminRepo,
    quarantineRepository: quarantine,
    judge,
    routing: DIRECT_ROUTING,
  });
  return { service, adminRepo, staging, promotion, promote, quarantine, judge };
}

export type { MemoryStatus };
