/**
 * LifecycleService unit tests (C4, HU-12, HU-11.4) over FakeLifecycleRepository:
 * DTO mapping, reason policy (secret → invalid_reason before any repository
 * call, PII masked, clamp to 500), sweep aggregation and idempotence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LifecycleService } from '../../src/lifecycle/lifecycleService.js';
import { REVALIDATION_SWEEP_JOB } from '../../src/lifecycle/types.js';
import type { AdminActor } from '../../src/mcp/context.js';
import { logger } from '../../src/observability/logger.js';
import { FakeLifecycleRepository, makeMemory } from './fakes.js';

const P = '00000000-0000-0000-0000-0000000000a1';
const Q = '00000000-0000-0000-0000-0000000000b1';
const ACTOR: AdminActor = { actorId: 'sub-admin-a', userId: 'u-admin-a', roles: ['project_admin'] };
const DAY_MS = 86_400_000;

let repo: FakeLifecycleRepository;
let svc: LifecycleService;

beforeEach(() => {
  repo = new FakeLifecycleRepository();
  svc = new LifecycleService({ lifecycleRepository: repo });
});

describe('LifecycleService.list', () => {
  it('maps rows to camelCase DTOs with ISO timestamps and passes the truncation flag', async () => {
    const due = new Date('2026-03-01T10:00:00.000Z');
    const m = makeMemory({
      projectId: P,
      status: 'pending_revalidation',
      revalidateAt: due,
      originPr: 42,
      currentRevision: 3,
    });
    repo.memories.push(m, makeMemory({ projectId: P, status: 'pending_revalidation' }));

    const dto = await svc.list(P, { status: 'pending_revalidation', limit: 1 });
    expect(dto.truncated).toBe(true);
    expect(dto.items).toEqual([
      {
        id: m.id,
        type: 'gotcha',
        title: m.title,
        summary: m.summary,
        status: 'pending_revalidation',
        version: 3,
        originBranch: 'main',
        originPr: 42,
        revalidateAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('maps a NULL deadline to null', async () => {
    repo.memories.push(
      makeMemory({ projectId: P, status: 'pending_revalidation', revalidateAt: null }),
    );
    const dto = await svc.list(P, { status: 'pending_revalidation', limit: 10 });
    expect(dto.items[0]!.revalidateAt).toBeNull();
  });
});

describe('LifecycleService.confirm', () => {
  it('pending → confirmed with a fresh deadline', async () => {
    const m = makeMemory({ projectId: P, status: 'pending_revalidation' });
    repo.memories.push(m);
    const out = await svc.confirm(ACTOR, P, m.id);
    expect(out.kind).toBe('confirmed');
    if (out.kind !== 'confirmed') return;
    expect(out.dto.memoryId).toBe(m.id);
    expect(out.dto.status).toBe('active');
    const days = (Date.parse(out.dto.revalidateAt!) - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(59.9);
  });

  it('active, foreign or unknown → not_found', async () => {
    const active = makeMemory({ projectId: P });
    const foreign = makeMemory({ projectId: Q, status: 'pending_revalidation' });
    repo.memories.push(active, foreign);
    expect(await svc.confirm(ACTOR, P, active.id)).toEqual({ kind: 'not_found' });
    expect(await svc.confirm(ACTOR, P, foreign.id)).toEqual({ kind: 'not_found' });
    expect(await svc.confirm(ACTOR, P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11')).toEqual({
      kind: 'not_found',
    });
  });
});

describe('LifecycleService.retire', () => {
  it('retires with the actor id and returns the new version', async () => {
    const m = makeMemory({ projectId: P, currentRevision: 2 });
    repo.memories.push(m);
    const out = await svc.retire(ACTOR, P, m.id, 'obsolete after migration');
    expect(out).toEqual({
      kind: 'retired',
      dto: { memoryId: m.id, status: 'deprecated', version: 3 },
    });
    expect(repo.revisions).toEqual([
      { memoryId: m.id, revisionNo: 3, op: 'deprecate', authorIdentity: 'sub-admin-a' },
    ]);
    expect(m.retiredReason).toBe('obsolete after migration');
  });

  it('a reason carrying a secret → invalid_reason with no repository call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    const out = await svc.retire(ACTOR, P, m.id, 'leaked key AKIAIOSFODNN7EXAMPLE here');
    expect(out).toEqual({ kind: 'invalid_reason' });
    expect(repo.calls).toHaveLength(0);
    // The warning never carries the reason.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('AKIA');
    warn.mockRestore();
  });

  it('masks an email in the stored reason', async () => {
    const m = makeMemory({ projectId: P });
    repo.memories.push(m);
    await svc.retire(ACTOR, P, m.id, 'ask jane.doe@example.com why');
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
    await svc.retire(ACTOR, P, m.id, reason);
    expect(m.retiredReason!.length).toBeLessThanOrEqual(500);
    expect(m.retiredReason).toContain('[EMAIL]');
  });

  it('repository null → not_found', async () => {
    expect(await svc.retire(ACTOR, P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11', 'gone now')).toEqual({
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
    expect(await svc.retireByPr(ACTOR, P, 42, 'reverted PR')).toEqual({
      kind: 'retired',
      dto: { retired: 2 },
    });
    expect(await svc.retireByPr(ACTOR, P, 42, 'reverted PR')).toEqual({
      kind: 'retired',
      dto: { retired: 0 },
    });
  });

  it('a secret reason → invalid_reason with no repository call', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(await svc.retireByPr(ACTOR, P, 42, 'token AKIAIOSFODNN7EXAMPLE')).toEqual({
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
