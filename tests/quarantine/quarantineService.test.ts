import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuarantineService } from '../../src/quarantine/quarantineService.js';
import { logger } from '../../src/observability/logger.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { ProjectMember } from '../../src/mcp/context.js';
import { DETAIL, FakeQuarantineRepository, ROW, ScriptedPromoteService } from './fakes.js';

const PROJECT = 'proj-1';
const ADMIN: ProjectMember = {
  actorId: 'tl-sub',
  userId: 'u-tl',
  roles: ['project_admin'],
  projectRole: 'project_admin',
};
const CONTRIB: ProjectMember = {
  actorId: 'dev-sub',
  userId: 'u-dev',
  roles: ['contributor'],
  projectRole: 'contributor',
};

function build(result?: ConstructorParameters<typeof ScriptedPromoteService>[0]) {
  const repo = new FakeQuarantineRepository();
  const promote = new ScriptedPromoteService(result);
  const service = new QuarantineService({ quarantineRepository: repo, promoteService: promote });
  return { repo, promote, service };
}

afterEach(() => vi.restoreAllMocks());

describe('QuarantineService — viewer mapping', () => {
  it('admin lists with isAdmin true', async () => {
    const { repo, service } = build();
    const dto = await service.list(ADMIN, PROJECT, { reason: null, limit: 100 });
    expect(repo.listCalls[0]!.v).toEqual({ isAdmin: true, subject: 'tl-sub' });
    expect(dto).toEqual({
      items: [{ ...ROW, quarantinedAt: '2026-11-01T10:00:00.000Z' }],
      truncated: false,
    });
  });

  it('a non-admin always sends isAdmin false with its own subject', async () => {
    const { repo, service } = build();
    await service.list(CONTRIB, PROJECT, { reason: 'secret_detected', limit: 5 });
    await service.get(CONTRIB, PROJECT, ROW.id);
    expect(repo.listCalls[0]).toEqual({
      projectId: PROJECT,
      v: { isAdmin: false, subject: 'dev-sub' },
      q: { reason: 'secret_detected', limit: 5 },
    });
    expect(repo.findCalls[0]!.v).toEqual({ isAdmin: false, subject: 'dev-sub' });
  });

  it('SEC-L5: judgeReason only for project admins; authors get reasonCode/criterion only', async () => {
    const { repo, service } = build();
    expect((await service.get(ADMIN, PROJECT, ROW.id))!.judgeReason).toBe('specificity');
    repo.author = 'dev-sub';
    const author = (await service.get(CONTRIB, PROJECT, ROW.id))!;
    expect(author).not.toHaveProperty('judgeReason');
    expect(author).toMatchObject({ reasonCode: 'judge_rejected', criterion: 'judge' });
  });

  it.each([
    ['secret_detected', {}],
    ['sanitize_failed', {}],
    ['judge_rejected', { body: '[REDACTADO]' }],
    ['human_rejected', { title: '[REDACTADO]' }],
    ['judge_rejected', { summary: '[REDACTADO]' }],
  ] as const)('SEC-L3: %s %o → canRestore false even for an admin', async (reasonCode, over) => {
    const { repo, service } = build();
    repo.detail = { ...DETAIL, reasonCode, ...over };
    expect((await service.get(ADMIN, PROJECT, ROW.id))!.canRestore).toBe(false);
  });

  it('SEC-L3: a partly redacted judge row stays restorable', async () => {
    const { service } = build();
    // DETAIL.body = 'Deploy failed with [REDACTADO]' (not equal to the sentinel).
    expect((await service.get(ADMIN, PROJECT, ROW.id))!.canRestore).toBe(true);
  });

  it('detail maps dates and canRestore (admin true, author false); null passthrough', async () => {
    const { repo, service } = build();
    const admin = await service.get(ADMIN, PROJECT, ROW.id);
    expect(admin).toMatchObject({
      id: ROW.id,
      canRestore: true,
      judgeReason: 'specificity',
      expiresAt: '2026-12-31T10:00:00.000Z',
      quarantinedAt: '2026-11-01T10:00:00.000Z',
    });
    repo.author = 'dev-sub';
    expect((await service.get(CONTRIB, PROJECT, ROW.id))!.canRestore).toBe(false);
    repo.detail = null;
    expect(await service.get(ADMIN, PROJECT, ROW.id)).toBeNull();
    expect(DETAIL.related).toBeNull();
  });
});

describe('QuarantineService.restore', () => {
  it('claims with the restorer ids and runs promoteItem on the restore session', async () => {
    const { repo, promote, service } = build();
    await service.restore(ADMIN, PROJECT, ROW.id);
    expect(repo.claimCalls).toEqual([
      { projectId: PROJECT, quarantineId: ROW.id, restoredByUserId: 'u-tl', openedBy: 'tl-sub' },
    ]);
    expect(promote.calls).toEqual([
      {
        sessionId: 'sess-restore',
        itemId: 'item-restore',
        origin: {
          tenant: { projectId: PROJECT, repoId: 'repo-1', branch: `restore/${ROW.id}` },
          originBranch: `restore/${ROW.id}`,
          originPr: 7,
        },
      },
    ]);
  });

  it('applied → memoryId', async () => {
    const { service } = build({ outcome: 'applied', memoryId: 'mem-9', deduped: false });
    expect(await service.restore(ADMIN, PROJECT, ROW.id)).toEqual({
      kind: 'restored',
      dto: { outcome: 'applied', memoryId: 'mem-9' },
      audit: {
        quarantineId: ROW.id,
        itemId: 'item-restore',
        outcome: 'applied',
        memoryId: 'mem-9',
      },
    });
  });

  it('queued → itemId', async () => {
    const { service } = build({ outcome: 'queued', itemId: 'item-restore' });
    expect(await service.restore(ADMIN, PROJECT, ROW.id)).toMatchObject({
      dto: { outcome: 'queued', itemId: 'item-restore' },
      audit: { outcome: 'queued' },
    });
  });

  it('quarantined → the NEW quarantine id', async () => {
    const { service } = build({
      outcome: 'quarantined',
      itemId: 'item-restore',
      quarantineId: 'q-new',
    });
    expect(await service.restore(ADMIN, PROJECT, ROW.id)).toMatchObject({
      dto: { outcome: 'quarantined', quarantineId: 'q-new' },
      audit: { outcome: 'quarantined', newQuarantineId: 'q-new', quarantineId: ROW.id },
    });
  });

  it('not_found claim passes through; pipeline never runs', async () => {
    const { repo, promote, service } = build();
    repo.claimResult = { status: 'not_found' };
    expect(await service.restore(ADMIN, PROJECT, ROW.id)).toEqual({ kind: 'not_found' });
    expect(promote.calls).toHaveLength(0);
  });

  it('a pipeline throw after the claim is logged with ids and rethrown', async () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { service } = build(new Error('db down'));
    await expect(service.restore(ADMIN, PROJECT, ROW.id)).rejects.toThrow('db down');
    expect(err).toHaveBeenCalledWith('[quarantine] restore pipeline failed after claim', {
      quarantineId: ROW.id,
      itemId: 'item-restore',
      errorName: 'Error',
    });
  });

  it('skipped → INTERNAL', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { service } = build({ outcome: 'skipped', itemId: 'item-restore' });
    const p = service.restore(ADMIN, PROJECT, ROW.id);
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
  });
});
