/**
 * Test doubles for the memory lifecycle (C4).
 *
 * FakeLifecycleRepository is stateful: it mirrors the SQL guards of
 * PgLifecycleRepository (project scope, status predicates, outcome exemption)
 * over an in-memory row list and records every call for assertions.
 */

import type { MemoryType } from '../../src/contracts/memory.js';
import type {
  ConfirmResult,
  LifecycleRepository,
  RetireByPrResult,
  RetireResult,
} from '../../src/db/lifecycleRepository.js';
import type { TxnAudit } from '../../src/db/authRepository.js';
import { FAKE_TXN } from '../auth/txnAudit.js';
import type { MemoryStatus } from '../../src/db/memoryAdminRepository.js';

export interface FakeLifecycleMemory {
  id: string;
  projectId: string;
  type: MemoryType;
  title: string;
  summary: string;
  status: MemoryStatus;
  currentRevision: number;
  originBranch: string | null;
  originPr: number | null;
  revalidateAt: Date | null;
  updatedAt: Date;
  retiredReason: string | null;
}

export interface FakeRevision {
  memoryId: string;
  revisionNo: number;
  op: 'deprecate';
  authorIdentity: string;
}

const DAY_MS = 86_400_000;

let seq = 0;

/** A memory row with sensible defaults; ids are valid UUIDs. */
export function makeMemory(
  p: Partial<FakeLifecycleMemory> & { projectId: string },
): FakeLifecycleMemory {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    type: 'gotcha',
    title: `Memory ${seq}`,
    summary: `Summary ${seq}`,
    status: 'active',
    currentRevision: 1,
    originBranch: 'main',
    originPr: null,
    revalidateAt: new Date(Date.now() + 30 * DAY_MS),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    retiredReason: null,
    ...p,
  };
}

export class FakeLifecycleRepository implements LifecycleRepository {
  readonly revisions: FakeRevision[] = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** When set, sweepExpired rejects with this error. */
  sweepError: Error | null = null;

  constructor(
    readonly memories: FakeLifecycleMemory[] = [],
    private readonly revalidationDays = 60,
  ) {}

  find(id: string): FakeLifecycleMemory | undefined {
    return this.memories.find((m) => m.id === id);
  }

  // Each write runs its audit hook before mutating (a failing hook leaves the
  // fake unchanged, like the real ROLLBACK).
  async confirm(
    projectId: string,
    memoryId: string,
    audit?: TxnAudit<ConfirmResult>,
  ): Promise<ConfirmResult | null> {
    this.calls.push({ method: 'confirm', args: [projectId, memoryId] });
    const m = this.find(memoryId);
    if (!m || m.projectId !== projectId || m.status !== 'pending_revalidation') return null;
    const revalidateAt =
      m.type === 'outcome' ? null : new Date(Date.now() + this.revalidationDays * DAY_MS);
    const result = { memoryId, revalidateAt };
    if (audit) await audit(FAKE_TXN, result);
    m.status = 'active';
    m.revalidateAt = revalidateAt;
    return result;
  }

  private retireRow(m: FakeLifecycleMemory, reason: string, actorIdentity: string): number {
    m.status = 'deprecated';
    m.retiredReason = reason;
    m.revalidateAt = null;
    m.currentRevision += 1;
    this.revisions.push({
      memoryId: m.id,
      revisionNo: m.currentRevision,
      op: 'deprecate',
      authorIdentity: actorIdentity,
    });
    return m.currentRevision;
  }

  private retirable(m: FakeLifecycleMemory, projectId: string): boolean {
    return (
      m.projectId === projectId && (m.status === 'active' || m.status === 'pending_revalidation')
    );
  }

  async retire(
    projectId: string,
    memoryId: string,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireResult>,
  ): Promise<RetireResult | null> {
    this.calls.push({ method: 'retire', args: [projectId, memoryId, reason, actorIdentity] });
    const m = this.find(memoryId);
    if (!m || !this.retirable(m, projectId)) return null;
    if (audit) await audit(FAKE_TXN, { memoryId, revision: m.currentRevision + 1 });
    return { memoryId, revision: this.retireRow(m, reason, actorIdentity) };
  }

  async retireByPr(
    projectId: string,
    originPr: number,
    reason: string,
    actorIdentity: string,
    audit?: TxnAudit<RetireByPrResult>,
  ): Promise<RetireByPrResult> {
    this.calls.push({ method: 'retireByPr', args: [projectId, originPr, reason, actorIdentity] });
    const targets = this.memories
      .filter((m) => this.retirable(m, projectId) && m.originPr === originPr)
      .sort((a, b) => a.id.localeCompare(b.id));
    const result = { retired: targets.length, memoryIds: targets.map((m) => m.id) };
    if (audit) await audit(FAKE_TXN, result);
    for (const m of targets) this.retireRow(m, reason, actorIdentity);
    return result;
  }

  async sweepExpired(): Promise<Array<{ projectId: string; count: number }>> {
    this.calls.push({ method: 'sweepExpired', args: [] });
    if (this.sweepError) throw this.sweepError;
    const counts = new Map<string, number>();
    const now = Date.now();
    for (const m of this.memories) {
      if (
        m.status === 'active' &&
        m.type !== 'outcome' &&
        m.revalidateAt !== null &&
        m.revalidateAt.getTime() < now
      ) {
        m.status = 'pending_revalidation';
        counts.set(m.projectId, (counts.get(m.projectId) ?? 0) + 1);
      }
    }
    return [...counts].map(([projectId, count]) => ({ projectId, count }));
  }
}
