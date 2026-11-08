/**
 * LifecycleService unit tests (C4, HU-12, HU-11.4) over FakeLifecycleRepository:
 * DTO mapping (the list moved to DirectMemoryService in C5), reason policy (secret → invalid_reason before any repository
 * call, PII masked, clamp to 500), sweep aggregation and idempotence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LifecycleService } from '../../src/lifecycle/lifecycleService.js';
import { REVALIDATION_SWEEP_JOB } from '../../src/lifecycle/types.js';
import type { AdminActor } from '../../src/mcp/context.js';
import { logger } from '../../src/observability/logger.js';
import { FakeLifecycleRepository, makeMemory } from './fakes.js';
import { recordingAudit } from '../auth/txnAudit.js';

const P = '00000000-0000-0000-0000-0000000000a1';
const Q = '00000000-0000-0000-0000-0000000000b1';
const ACTOR: AdminActor = { actorId: 'sub-admin-a', userId: 'u-admin-a', roles: ['project_admin'] };
const DAY_MS = 86_400_000;

let repo: FakeLifecycleRepository;
let svc: LifecycleService;
let rec: ReturnType<typeof recordingAudit>;

beforeEach(() => {
  repo = new FakeLifecycleRepository();
  svc = new LifecycleService({ lifecycleRepository: repo });
  rec = recordingAudit();
});

describe('LifecycleService.confirm', () => {
  it('pending → confirmed with a fresh deadline', async () => {
    const m = makeMemory({ projectId: P, status: 'pending_revalidation' });
    repo.memories.push(m);
    const out = await svc.confirm(ACTOR, P, m.id, rec.audit);
    expect(out.kind).toBe('confirmed');
    if (out.kind !== 'confirmed') return;
    expect(out.dto.memoryId).toBe(m.id);
    expect(out.dto.status).toBe('active');
    const days = (Date.parse(out.dto.revalidateAt!) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(59.9);
    expect(rec.details).toEqual([{ memoryId: m.id }]);
  });

  it('active, foreign or unknown → not_found', async () => {
    const active = makeMemory({ projectId: P });
    const foreign = makeMemory({ projectId: Q, status: 'pending_revalidation' });
    repo.memories.push(active, foreign);
    expect(await svc.confirm(ACTOR, P, active.id, rec.audit)).toEqual({ kind: 'not_found' });
    expect(await svc.confirm(ACTOR, P, foreign.id, rec.audit)).toEqual({ kind: 'not_found' });
    expect(await svc.confirm(ACTOR, P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11', rec.audit)).toEqual({
      kind: 'not_found',
    });
    expect(rec.details).toEqual([]);
  });

  it('C11 an audit failure propagates and leaves the memory pending', async () => {
    const m = makeMemory({ projectId: P, status: 'pending_revalidation' });
    repo.memories.push(m);
    await expect(
      svc.confirm(ACTOR, P, m.id, () => Promise.reject(new Error('audit down'))),
    ).rejects.toThrow('audit down');
    expect(m.status).toBe('pending_revalidation');
  });
});

describe('LifecycleService.retire', () => {
  it('retires with the actor id and returns the new version', async () => {
    const m = makeMemory({ projectId: P, currentRevision: 2 });
    repo.memories.push(m);
    const out = await svc.retire(ACTOR, P, m.id, 'obsolete after migration', rec.audit);
    expect(out).toEqual({
      kind: 'retired',
      dto: { memoryId: m.id, status: 'deprecated', version: 3 },
    });
    expect(repo.revisions).toEqual([
      { memoryId: m.id, revisionNo: 3, op: 'deprecate', authorIdentity: 'sub-admin-a' },
    ]);
    expect(m.retiredReason).toBe('obsolete after migration');
    // The audit detail never carries the reason.
    expect(rec.details).toEqual([{ memoryId: m.id }]);
  });

  it('C11 an audit failure propagates and leaves the memory active', async () => {
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    await expect(
      svc.retire(ACTOR, P, m.id, 'obsolete', () => Promise.reject(new Error('audit down'))),
    ).rejects.toThrow('audit down');
    expect(m.status).toBe('active');
    expect(repo.revisions).toEqual([]);
  });

  it('a reason carrying a secret → invalid_reason with no repository call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    const out = await svc.retire(ACTOR, P, m.id, 'leaked key AKIAIOSFODNN7EXAMPLE here', rec.audit);
    expect(out).toEqual({ kind: 'invalid_reason' });
    expect(repo.calls).toHaveLength(0);
    // The warning never carries the reason.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('AKIA');
    warn.mockRestore();
  });

  it('masks an email in the stored reason', async () => {
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    await svc.retire(ACTOR, P, m.id, 'ask jane.doe@example.com why', rec.audit);
    expect(m.retiredReason).not.toContain('jane.doe@example.com');
    expect(m.retiredReason).toContain('[EMAIL]');
  });

  it('clamps a reason that masking pushed past 500 chars', async () => {
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    // Each 6-char "a@b.io" becomes the 7-char "[EMAIL]": 70 of them → 570 chars after masking.
    const emails = Array.from({ length: 70 }, () => 'a@b.io').join(' ');
    const reason = `${emails} ${'x'.repeat(500 - emails.length - 1)}`;
    expect(reason.length).toBe(500);
    await svc.retire(ACTOR, P, m.id, reason, rec.audit);
    expect(m.retiredReason!.length).toBeLessThanOrEqual(500);
    expect(m.retiredReason).toContain('[EMAIL]');
  });

  it('repository null → not_found', async () => {
    expect(
      await svc.retire(ACTOR, P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11', 'gone now', rec.audit),
    ).toEqual({
      kind: 'not_found',
    });
  });
});

describe('LifecycleService.retireByPr', () => {
  it('returns the count from the repository (0 allowed)', async () => {
    repo.memories.push(
      makeMemory({ projectId: P, originPr: 42 }),
      makeMemory({ projectId: P, originPr: 42, status: 'pending_revalidation' }),
      makeMemory({ projectId: P, originPr: 43 }),
      makeMemory({ projectId: Q, originPr: 42 }),
    );
    expect(await svc.retireByPr(ACTOR, P, 42, 'reverted PR', rec.audit)).toEqual({
      kind: 'retired',
      dto: { retired: 2 },
    });
    expect(await svc.retireByPr(ACTOR, P, 42, 'reverted PR', rec.audit)).toEqual({
      kind: 'retired',
      dto: { retired: 0 },
    });
    expect(rec.details).toEqual([
      { originPr: 42, resultCount: 2 },
      { originPr: 42, resultCount: 0 },
    ]);
  });

  it('a secret reason → invalid_reason with no repository call', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(await svc.retireByPr(ACTOR, P, 42, 'token AKIAIOSFODNN7EXAMPLE', rec.audit)).toEqual({
      kind: 'invalid_reason',
    });
    expect(repo.calls).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe('LifecycleService.sweep', () => {
  it('aggregates per-project counts and is idempotent', async () => {
    const past = new Date(Date.now() - DAY_MS);
    repo.memories.push(
      makeMemory({ projectId: P, revalidateAt: past }),
      makeMemory({ projectId: P, revalidateAt: past, type: 'decision' }),
      makeMemory({ projectId: Q, revalidateAt: past }),
      makeMemory({ projectId: P, revalidateAt: past, type: 'outcome' }),
      makeMemory({ projectId: P }),
    );
    expect(await svc.sweep()).toEqual({
      job: REVALIDATION_SWEEP_JOB,
      count: 3,
      detail: { [P]: 2, [Q]: 1 },
    });
    expect(await svc.sweep()).toEqual({ job: 'revalidation-sweep', count: 0, detail: {} });
  });

  it('propagates a repository error (never swallowed)', async () => {
    repo.sweepError = new Error('db down');
    await expect(svc.sweep()).rejects.toThrow('db down');
  });
});
