/**
 * C11: REST write audit rows commit atomically with the write.
 *
 * Real Pg repositories and services (FakeJudge accepted, StubEmbedder) over a
 * migrated Postgres. For each write kind: with the real RdsAuditLogger hook
 * the data change and its access_log row are committed together; with a hook
 * whose INSERT fails inside the transaction, the error propagates and the
 * data change is rolled back (nothing applied, no audit row).
 * SKIPPED without DATABASE_URL.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AdminActor, ApiAction, ApiWriteAudit, ProjectMember } from '../../src/mcp/context.js';
import type { RdsAuditLogger } from '../../src/auth/auditLogger.js';
import type { LifecycleService } from '../../src/lifecycle/lifecycleService.js';
import type { ReviewService } from '../../src/review/reviewService.js';
import type { DirectMemoryService } from '../../src/memory/directMemoryService.js';
import type { QuarantineService } from '../../src/quarantine/quarantineService.js';
import { logger } from '../../src/observability/logger.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'api-audit-atomic-integ';
const REPO_URL = 'https://github.com/test/api-audit-atomic-integ';
const TL = 'audit-atomic-tl-sub';

/** A real statement on the transaction client that fails (invalid actor_kind enum). */
const failingAudit: ApiWriteAudit = async (db) => {
  await db.query(
    `INSERT INTO access_log (actor_identity, actor_kind, action, detail)
     VALUES ('x', 'not_a_kind', 'update', '{}'::jsonb)`,
  );
};

describeWithDb('REST write audit atomicity (C11)', () => {
  let pool: pg.Pool;
  let projectId: string;
  let repoId: string;
  let actor: AdminActor;
  let member: ProjectMember;
  let auditLogger: RdsAuditLogger;
  let lifecycle: LifecycleService;
  let review: ReviewService;
  let direct: DirectMemoryService;
  let quarantine: QuarantineService;
  /** Same wiring, judge rejects (specificity): a restore that ends in quarantine. */
  let quarantineRejecting: QuarantineService;
  /** Real claim/release SQL, promoteItem that always throws (pipeline failure). */
  let quarantineBroken: QuarantineService;
  let seq = 0;

  const audit = (action: ApiAction) => auditLogger.apiWriteAudit(actor, { projectId }, action);

  async function auditRows(api: ApiAction): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `SELECT action, memory_id, detail FROM access_log
        WHERE project_id = $1 AND detail->>'api' = $2 ORDER BY id`,
      [projectId, api],
    );
    return rows as Array<Record<string, unknown>>;
  }

  async function insertMemory(
    p: { status?: string; originPr?: number | null; title?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, origin_pr)
       VALUES ($1, $2, 'pattern', $3, 'Seed memory summary.', 'Seed memory body.',
               $4::memory_status, 'pr_reviewed', 'seed-user', $5, $6)
       RETURNING id`,
      [
        projectId,
        repoId,
        p.title ?? `Seed memory ${++seq}`,
        p.status ?? 'active',
        `audit-atomic-mem-${++seq}`,
        p.originPr ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function memoryStatus(id: string): Promise<string> {
    return (await pool.query(`SELECT status FROM memory WHERE id = $1`, [id])).rows[0].status;
  }

  async function queuedItem(): Promise<string> {
    const sessionId = `audit-atomic-sess-${++seq}`;
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, status, pr_number)
       VALUES ($1, $2, $3, $4, 'integ', 'open', 12)`,
      [sessionId, projectId, repoId, `audit-atomic-branch-${seq}`],
    );
    const { rows } = await pool.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity,
          judge_state, judge_criterion, judge_confidence, mandatory_review)
       VALUES ($1, 'add', 'pattern', $2, 'Queued item summary.', 'Queued item body with detail.',
               $3, 'integ-author', 'uncertain', 'confidence', 0.5, false)
       RETURNING id`,
      [sessionId, `Queued item ${seq}`, `audit-atomic-item-${seq}`],
    );
    return rows[0].id as string;
  }

  async function itemState(id: string) {
    return (
      await pool.query(
        `SELECT promoted_at, reviewed_at, review_decision FROM staging_item WHERE id = $1`,
        [id],
      )
    ).rows[0] as { promoted_at: Date | null; reviewed_at: Date | null; review_decision: string };
  }

  async function seedQuarantine(title: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, op, type, title, summary, body, content_hash,
          judge_reason, author_identity, criterion, reason_code, expires_at)
       VALUES ($1, $2, 'audit-atomic-origin', 'add', 'pattern', $3,
               'Every DB seam is a class over pg.Pool with SQL constants.',
               'See src/db/promotionRepository.ts: parameterized SQL constants per item.',
               $4, 'specificity', 'audit-atomic-author', 'judge', 'judge_rejected',
               now() + interval '60 days')
       RETURNING id`,
      [projectId, repoId, title, `audit-atomic-q-${++seq}`],
    );
    return rows[0].id as string;
  }

  const countWhere = async (sql: string, params: unknown[]): Promise<number> =>
    (await pool.query(sql, params)).rows[0].n as number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    projectId = (
      await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, 'Audit atomic') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;
    repoId = (
      await pool.query(
        `INSERT INTO repo (project_id, remote_url, slug) VALUES ($1, $2, 'test/audit-atomic')
         ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
        [projectId, REPO_URL],
      )
    ).rows[0].id;
    const userId = (
      await pool.query(
        `INSERT INTO app_user (idp_subject, email, display_name) VALUES ($1, $1 || '@x.io', 'TL')
         ON CONFLICT (idp_subject) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [TL],
      )
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO project_membership (project_id, user_id, role)
       VALUES ($1, $2, 'project_admin') ON CONFLICT (project_id, user_id) DO NOTHING`,
      [projectId, userId],
    );
    actor = { actorId: TL, userId, roles: ['project_admin'] };
    member = { ...actor, projectRole: 'project_admin' };

    const { PgAuthRepository } = await import('../../src/db/authRepository.js');
    const { PgPromotionRepository } = await import('../../src/db/promotionRepository.js');
    const { PgStagingRepository } = await import('../../src/db/stagingRepository.js');
    const { PgQuarantineRepository } = await import('../../src/db/quarantineRepository.js');
    const { PgReviewQueueRepository } = await import('../../src/db/reviewQueueRepository.js');
    const { PgLifecycleRepository } = await import('../../src/db/lifecycleRepository.js');
    const { PgMemoryAdminRepository } = await import('../../src/db/memoryAdminRepository.js');
    const { RdsAuditLogger } = await import('../../src/auth/auditLogger.js');
    const { StubEmbedder } = await import('../../src/embedder/stubEmbedder.js');
    const { PromoteService } = await import('../../src/promote/promoteService.js');
    const { LifecycleService } = await import('../../src/lifecycle/lifecycleService.js');
    const { ReviewService } = await import('../../src/review/reviewService.js');
    const { DirectMemoryService } = await import('../../src/memory/directMemoryService.js');
    const { QuarantineService } = await import('../../src/quarantine/quarantineService.js');
    const { FakeJudge, FakeNotifier, accepted, rejected } = await import('../promote/fakes.js');

    auditLogger = new RdsAuditLogger(new PgAuthRepository(pool));
    const promotionRepository = new PgPromotionRepository(pool, {
      quarantineRetentionDays: 60,
      revalidationDays: 60,
    });
    const judge = new FakeJudge([accepted(0.95)]);
    const embedder = new StubEmbedder();
    const routing = {
      confidenceThreshold: 0.8,
      mandatoryReviewTypes: new Set(['decision', 'constraint', 'domain_rule'] as const),
    };
    const promoteService = new PromoteService({
      promotionRepository,
      judge,
      auditLogger,
      embedder,
      notifier: new FakeNotifier(),
      routing,
    });
    const reviewQueueRepository = new PgReviewQueueRepository(pool);
    const quarantineRepository = new PgQuarantineRepository(pool);
    lifecycle = new LifecycleService({
      lifecycleRepository: new PgLifecycleRepository(pool, { revalidationDays: 60 }),
    });
    review = new ReviewService({
      reviewQueueRepository,
      promotionRepository,
      embedder,
      confidenceThreshold: 0.8,
    });
    direct = new DirectMemoryService({
      memoryAdminRepository: new PgMemoryAdminRepository(pool),
      stagingRepository: new PgStagingRepository(pool),
      promotionRepository,
      promoteService,
      reviewQueueRepository,
      quarantineRepository,
      judge,
      routing,
    });
    quarantine = new QuarantineService({ quarantineRepository, promoteService });
    quarantineRejecting = new QuarantineService({
      quarantineRepository,
      promoteService: new PromoteService({
        promotionRepository,
        judge: new FakeJudge([rejected('specificity')]),
        auditLogger,
        embedder,
        notifier: new FakeNotifier(),
        routing,
      }),
    });
    quarantineBroken = new QuarantineService({
      quarantineRepository,
      promoteService: { promoteItem: () => Promise.reject(new Error('pipeline down')) },
    });
  });

  beforeEach(async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await pool.query(`DELETE FROM staging_session WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM quarantine WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM access_log WHERE project_id = $1`, [projectId]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
  });

  describe('lifecycle', () => {
    it('retire: memory + audit row commit together', async () => {
      const id = await insertMemory();
      const out = await lifecycle.retire(actor, projectId, id, 'obsolete', audit('memory.retire'));
      expect(out.kind).toBe('retired');
      expect(await memoryStatus(id)).toBe('deprecated');
      const rows = await auditRows('memory.retire');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'update', memory_id: id });
      expect(JSON.stringify(rows)).not.toContain('obsolete');
    });

    it('retire: audit failure rolls the retire back (memory active, no revision)', async () => {
      const id = await insertMemory();
      await expect(
        lifecycle.retire(actor, projectId, id, 'obsolete', failingAudit),
      ).rejects.toThrow();
      expect(await memoryStatus(id)).toBe('active');
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM memory_revision WHERE memory_id = $1`, [
          id,
        ]),
      ).toBe(0);
      expect(await auditRows('memory.retire')).toHaveLength(0);
    });

    it('confirm: committed with its row; an audit failure leaves it pending', async () => {
      const failed = await insertMemory({ status: 'pending_revalidation' });
      await expect(lifecycle.confirm(actor, projectId, failed, failingAudit)).rejects.toThrow();
      expect(await memoryStatus(failed)).toBe('pending_revalidation');

      const ok = await insertMemory({ status: 'pending_revalidation' });
      expect((await lifecycle.confirm(actor, projectId, ok, audit('memory.confirm'))).kind).toBe(
        'confirmed',
      );
      expect(await memoryStatus(ok)).toBe('active');
      expect(await auditRows('memory.confirm')).toEqual([
        expect.objectContaining({ memory_id: ok }),
      ]);
    });

    it('retire-by-pr: all or nothing with its row', async () => {
      const a = await insertMemory({ originPr: 77 });
      const b = await insertMemory({ originPr: 77 });
      await expect(
        lifecycle.retireByPr(actor, projectId, 77, 'reverted', failingAudit),
      ).rejects.toThrow();
      expect([await memoryStatus(a), await memoryStatus(b)]).toEqual(['active', 'active']);

      const out = await lifecycle.retireByPr(
        actor,
        projectId,
        77,
        'reverted',
        audit('memory.retire_by_pr'),
      );
      expect(out).toEqual({ kind: 'retired', dto: { retired: 2 } });
      const rows = await auditRows('memory.retire_by_pr');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({ originPr: 77, resultCount: 2 });
    });
  });

  describe('review queue', () => {
    it('approve: memory + approval + audit row commit together', async () => {
      const itemId = await queuedItem();
      const out = await review.approve(
        actor,
        projectId,
        itemId,
        { markRelatedSuperseded: false },
        audit('review_queue.approve'),
      );
      expect(out.kind).toBe('approved');
      const st = await itemState(itemId);
      expect(st.promoted_at).not.toBeNull();
      const rows = await auditRows('review_queue.approve');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({ itemId, decision: 'approved' });
    });

    it('approve: audit failure rolls back (item still queued, no memory)', async () => {
      const itemId = await queuedItem();
      await expect(
        review.approve(actor, projectId, itemId, { markRelatedSuperseded: false }, failingAudit),
      ).rejects.toThrow();
      const st = await itemState(itemId);
      expect(st.promoted_at).toBeNull();
      expect(st.reviewed_at).toBeNull();
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM memory WHERE project_id = $1`, [
          projectId,
        ]),
      ).toBe(0);
      expect(await auditRows('review_queue.approve')).toHaveLength(0);
    });

    it('reject: audit failure leaves no quarantine row; success commits both', async () => {
      const itemId = await queuedItem();
      await expect(
        review.reject(actor, projectId, itemId, { reason: 'too vague' }, failingAudit),
      ).rejects.toThrow();
      expect((await itemState(itemId)).reviewed_at).toBeNull();
      const qCount = () =>
        countWhere(`SELECT count(*)::int AS n FROM quarantine WHERE project_id = $1`, [projectId]);
      expect(await qCount()).toBe(0);

      const out = await review.reject(
        actor,
        projectId,
        itemId,
        { reason: 'too vague' },
        audit('review_queue.reject'),
      );
      expect(out.kind).toBe('rejected');
      expect(await qCount()).toBe(1);
      const rows = await auditRows('review_queue.reject');
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('too vague');
    });
  });

  describe('direct management', () => {
    const unit = (
      title: string,
      body = 'Raise PGPOOL_MAX to 30 in src/db/pool.ts under load.',
    ) => ({
      type: 'gotcha' as const,
      title,
      summary: 'The pg pool starves the worker under burst traffic.',
      body,
      fields: {},
      repoId: null,
    });
    const memoriesTitled = (title: string) =>
      countWhere(`SELECT count(*)::int AS n FROM memory WHERE project_id = $1 AND title = $2`, [
        projectId,
        title,
      ]);

    it('create (applied): memory + audit row commit together', async () => {
      const out = await direct.create(
        actor,
        projectId,
        unit('Pool exhaustion committed'),
        audit('memory.create'),
      );
      expect(out.kind).toBe('done');
      expect(await memoriesTitled('Pool exhaustion committed')).toBe(1);
      const rows = await auditRows('memory.create');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({ outcome: 'applied', deduped: false });
    });

    it('create (applied): audit failure rolls the memory back and abandons the session', async () => {
      await expect(
        direct.create(actor, projectId, unit('Pool exhaustion rolled back'), failingAudit),
      ).rejects.toThrow();
      expect(await memoriesTitled('Pool exhaustion rolled back')).toBe(0);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM staging_session
            WHERE project_id = $1 AND branch LIKE 'web/%' AND status = 'open'`,
          [projectId],
        ),
      ).toBe(0);
      expect(await auditRows('memory.create')).toHaveLength(0);
    });

    it('create (quarantined): snapshot + audit row together; failure leaves neither', async () => {
      // Assembled at runtime: no literal credential in the repo.
      const leaky = unit('Leaky deploy note', `Deploy used ${'AKIA'}${'AUDITATOMIC7Q3K9'} in CI.`);
      const qCount = () =>
        countWhere(`SELECT count(*)::int AS n FROM quarantine WHERE project_id = $1`, [projectId]);

      await expect(direct.create(actor, projectId, leaky, failingAudit)).rejects.toThrow();
      expect(await qCount()).toBe(0);

      const out = await direct.create(actor, projectId, leaky, audit('memory.create'));
      expect(out).toMatchObject({ kind: 'done', dto: { outcome: 'quarantined' } });
      expect(await qCount()).toBe(1);
      expect((await auditRows('memory.create'))[0]!.detail).toMatchObject({
        outcome: 'quarantined',
      });
    });

    async function memoryRow(id: string) {
      return (await pool.query(`SELECT title, current_revision FROM memory WHERE id = $1`, [id]))
        .rows[0] as { title: string; current_revision: number };
    }

    it('amend (applied): new revision + exactly one audit row commit together', async () => {
      const id = await insertMemory({ title: 'Amend target committed' });
      const out = await direct.amend(
        actor,
        projectId,
        id,
        { ...unit('Amend target committed v2'), type: 'pattern', expectedRevision: 1 },
        audit('memory.amend'),
      );
      expect(out).toMatchObject({ kind: 'done', dto: { outcome: 'applied' } });
      expect(await memoryRow(id)).toEqual({
        title: 'Amend target committed v2',
        current_revision: 2,
      });
      const rows = await auditRows('memory.amend');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'update', memory_id: id });
      expect(rows[0]!.detail).toMatchObject({ outcome: 'applied' });
    });

    it('amend (applied): audit failure rolls the amend back (no revision, session abandoned)', async () => {
      const id = await insertMemory({ title: 'Amend target rolled back' });
      await expect(
        direct.amend(
          actor,
          projectId,
          id,
          { ...unit('Amend target rolled back v2'), type: 'pattern', expectedRevision: 1 },
          failingAudit,
        ),
      ).rejects.toThrow();
      expect(await memoryRow(id)).toEqual({
        title: 'Amend target rolled back',
        current_revision: 1,
      });
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM memory_revision WHERE memory_id = $1`, [
          id,
        ]),
      ).toBe(0);
      expect(
        await countWhere(
          `SELECT count(*)::int AS n FROM staging_session
            WHERE project_id = $1 AND branch LIKE 'web/%' AND status = 'open'`,
          [projectId],
        ),
      ).toBe(0);
      expect(await auditRows('memory.amend')).toHaveLength(0);
    });
  });

  describe('quarantine restore', () => {
    it('applied restore commits with its row; an audit failure applies nothing', async () => {
      const failedId = await seedQuarantine('Restore rolled back pattern');
      await expect(quarantine.restore(member, projectId, failedId, failingAudit)).rejects.toThrow();
      expect(
        await countWhere(`SELECT count(*)::int AS n FROM memory WHERE project_id = $1`, [
          projectId,
        ]),
      ).toBe(0);
      expect(await auditRows('quarantine.restore')).toHaveLength(0);

      const okId = await seedQuarantine('Restore committed pattern');
      const out = await quarantine.restore(member, projectId, okId, audit('quarantine.restore'));
      expect(out).toMatchObject({ kind: 'restored', dto: { outcome: 'applied' } });
      const rows = await auditRows('quarantine.restore');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({ quarantineId: okId, outcome: 'applied' });
    });

    const quarantineCount = () =>
      countWhere(`SELECT count(*)::int AS n FROM quarantine WHERE project_id = $1`, [projectId]);

    async function claimState(qid: string) {
      const q = (
        await pool.query(
          `SELECT restored_by, restored_at, restored_item_id FROM quarantine WHERE id = $1`,
          [qid],
        )
      ).rows[0] as Record<string, unknown>;
      const sessions = (
        await pool.query(
          `SELECT status FROM staging_session WHERE project_id = $1 AND branch = $2 ORDER BY id`,
          [projectId, `restore/${qid}`],
        )
      ).rows.map((r: { status: string }) => r.status);
      return { ...q, sessions };
    }

    it('restore ending in quarantine: new snapshot + one audit row; failure writes neither', async () => {
      const failedId = await seedQuarantine('Restore to quarantine rolled back');
      await expect(
        quarantineRejecting.restore(member, projectId, failedId, failingAudit),
      ).rejects.toThrow();
      expect(await quarantineCount()).toBe(1); // only the seeded row
      expect(await auditRows('quarantine.restore')).toHaveLength(0);

      const okId = await seedQuarantine('Restore to quarantine committed');
      const out = await quarantineRejecting.restore(
        member,
        projectId,
        okId,
        audit('quarantine.restore'),
      );
      expect(out).toMatchObject({ kind: 'restored', dto: { outcome: 'quarantined' } });
      const newId = (out as { dto: { quarantineId?: string } }).dto.quarantineId;
      expect(newId).toBeDefined();
      expect(await quarantineCount()).toBe(3); // two seeded + the new snapshot
      const rows = await auditRows('quarantine.restore');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatchObject({
        quarantineId: okId,
        outcome: 'quarantined',
        newQuarantineId: newId,
      });
    });

    it('un-claim: an audit failure releases the claim and a retry restores it', async () => {
      const qid = await seedQuarantine('Restore retried after audit failure');
      await expect(quarantine.restore(member, projectId, qid, failingAudit)).rejects.toThrow();
      expect(await claimState(qid)).toEqual({
        restored_by: null,
        restored_at: null,
        restored_item_id: null,
        sessions: ['abandoned'],
      });

      const out = await quarantine.restore(member, projectId, qid, audit('quarantine.restore'));
      expect(out).toMatchObject({ kind: 'restored', dto: { outcome: 'applied' } });
      const st = await claimState(qid);
      expect(st.restored_at).not.toBeNull();
      expect(st.sessions).toHaveLength(2);
      expect(await auditRows('quarantine.restore')).toHaveLength(1);
    });

    it('un-claim: a pipeline failure releases the claim (row listed again)', async () => {
      const qid = await seedQuarantine('Restore retried after pipeline failure');
      await expect(
        quarantineBroken.restore(member, projectId, qid, audit('quarantine.restore')),
      ).rejects.toThrow('pipeline down');
      expect(await claimState(qid)).toEqual({
        restored_by: null,
        restored_at: null,
        restored_item_id: null,
        sessions: ['abandoned'],
      });
      const listed = await quarantine.list(member, projectId, { reason: null, limit: 50 });
      expect(listed.items.map((i) => i.id)).toContain(qid);
      expect(await auditRows('quarantine.restore')).toHaveLength(0);
    });

    it('un-claim never releases a committed restore (applied or quarantined)', async () => {
      const { PgQuarantineRepository } = await import('../../src/db/quarantineRepository.js');
      const repo = new PgQuarantineRepository(pool);
      for (const svc of [quarantine, quarantineRejecting]) {
        const qid = await seedQuarantine(`Committed restore ${++seq}`);
        await svc.restore(member, projectId, qid, audit('quarantine.restore'));
        const { rows } = await pool.query(
          `SELECT q.restored_item_id AS item_id, si.session_id
             FROM quarantine q JOIN staging_item si ON si.id = q.restored_item_id
            WHERE q.id = $1`,
          [qid],
        );
        const before = await claimState(qid);
        expect(
          await repo.releaseRestoreClaim({
            projectId,
            quarantineId: qid,
            sessionId: rows[0].session_id as string,
            itemId: rows[0].item_id as string,
          }),
        ).toBe(false);
        expect(await claimState(qid)).toEqual(before);
        expect(before.restored_at).not.toBeNull();
      }
    });
  });
});
