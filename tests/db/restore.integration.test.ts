/**
 * HU-10.2 end to end (C3): real repositories + real PromoteService
 * (DeterministicJudge behind a spy) + the real /api router, RdsAuthorizer and
 * RdsAuditLogger over Postgres. Gate 1 is a fake bearer (`Bearer <subject>`).
 * SKIPPED without DATABASE_URL.
 */

import pg from 'pg';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { JudgeItem, JudgeContextItem } from '../../src/judge/judge.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'restore-integ';
const REPO_URL = 'https://github.com/test/restore-integ';
const ORIGIN_SESSION = '01J0RESTOREINTEG0000000000';
const TL = 'restore-tl-sub';
const AUTHOR = 'restore-author-sub';

describeWithDb('restore end to end (HU-10.2)', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let projectId: string;
  let repoId: string;
  let tlUserId: string;
  let targetId: string;
  const judgeCalls: JudgeItem[] = [];

  async function seed(
    over: {
      title?: string;
      summary?: string;
      body?: string;
      type?: string;
      op?: string;
      target?: string | null;
      targetRevision?: number | null;
      reason?: string;
      reasonCode?: string;
      criterion?: string;
      repo?: string | null;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, op, type, title, summary, body, content_hash,
          judge_reason, author_identity, criterion, reason_code, target_memory_id, target_revision, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-hash', $9, $10,
               $11::quarantine_criterion, $12::quarantine_reason_code, $13, $14, now() + interval '60 days')
       RETURNING id`,
      [
        projectId,
        over.repo === undefined ? repoId : over.repo,
        ORIGIN_SESSION,
        over.op ?? 'add',
        over.type ?? 'pattern',
        over.title ?? `Restorable pattern ${Math.random().toString(36).slice(2, 8)}`,
        over.summary ?? 'Every DB seam is a class over pg.Pool with SQL constants.',
        over.body ??
          'See src/db/promotionRepository.ts: parameterized SQL constants and per-item transactions.',
        over.reason ?? 'specificity',
        AUTHOR,
        over.criterion ?? 'judge',
        over.reasonCode ?? 'judge_rejected',
        over.target ?? null,
        over.targetRevision ?? null,
      ],
    );
    return rows[0].id as string;
  }

  const restore = (id: string) =>
    request(app)
      .post(`/api/v1/projects/${projectId}/quarantine/${id}/restore`)
      .set('Authorization', `Bearer ${TL}`)
      .send({});

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    projectId = (
      await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, 'Restore') ON CONFLICT (slug) DO UPDATE SET name = 'Restore' RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;
    repoId = (
      await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
         ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
        [projectId, REPO_URL],
      )
    ).rows[0].id;
    const user = async (sub: string, role: string) => {
      const id = (
        await pool.query(
          `INSERT INTO app_user (idp_subject, email) VALUES ($1, $1 || '@x.io')
           ON CONFLICT (idp_subject) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
          [sub],
        )
      ).rows[0].id as string;
      await pool.query(
        `INSERT INTO project_membership (project_id, user_id, role) VALUES ($1, $2, $3::project_role)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [projectId, id, role],
      );
      return id;
    };
    tlUserId = await user(TL, 'project_admin');
    await user(AUTHOR, 'contributor');
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, pr_number, status)
       VALUES ($1, $2, $3, 'feat/origin', $4, 77, 'rejected') ON CONFLICT DO NOTHING`,
      [ORIGIN_SESSION, projectId, repoId, AUTHOR],
    );
    targetId = (
      await pool.query(
        `INSERT INTO memory (project_id, type, title, summary, body, provenance, author_identity, content_hash, current_revision)
         VALUES ($1, 'pattern', 'Target pattern', 'Target summary', 'Target body in src/x.ts', 'pr_reviewed', 'x', 'restore-target', 2)
         RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    const { PgAuthRepository } = await import('../../src/db/authRepository.js');
    const { PgPromotionRepository } = await import('../../src/db/promotionRepository.js');
    const { PgQuarantineRepository } = await import('../../src/db/quarantineRepository.js');
    const { PgReviewQueueRepository } = await import('../../src/db/reviewQueueRepository.js');
    const { RdsAuthorizer } = await import('../../src/auth/authorizer.js');
    const { RdsAuditLogger } = await import('../../src/auth/auditLogger.js');
    const { DeterministicJudge } = await import('../../src/judge/deterministicJudge.js');
    const { PromoteService } = await import('../../src/promote/promoteService.js');
    const { ReviewService } = await import('../../src/review/reviewService.js');
    const { QuarantineService } = await import('../../src/quarantine/quarantineService.js');
    const { makeApiRouter } = await import('../../src/http/api/router.js');
    const { apiErrorHandler } = await import('../../src/http/api/errorHandler.js');
    const { FakeBearerAuthenticator } = await import('../http/api/helpers.js');

    const authRepo = new PgAuthRepository(pool);
    const auditLogger = new RdsAuditLogger(authRepo);
    const promotionRepository = new PgPromotionRepository(pool, { quarantineRetentionDays: 60, revalidationDays: 60 });
    const real = new DeterministicJudge({ acceptedConfidence: 0.9 });
    const judge = {
      evaluate: (item: JudgeItem, ctx: readonly JudgeContextItem[]) => {
        judgeCalls.push(item);
        return real.evaluate(item, ctx);
      },
    };
    const embedder = { embed: () => Promise.reject(new Error('no embedder in test')) };
    const promoteService = new PromoteService({
      promotionRepository,
      judge,
      auditLogger,
      embedder,
      notifier: { notify: () => Promise.resolve() },
      routing: {
        confidenceThreshold: 0.8,
        mandatoryReviewTypes: new Set(['decision', 'constraint', 'domain_rule']),
      },
    });
    const quarantineService = new QuarantineService({
      quarantineRepository: new PgQuarantineRepository(pool),
      promoteService,
    });
    const reviewService = new ReviewService({
      reviewQueueRepository: new PgReviewQueueRepository(pool),
      promotionRepository,
      embedder,
      confidenceThreshold: 0.8,
    });

    app = express();
    app.use(express.json());
    app.use(
      '/api',
      makeApiRouter(
        {
          authenticator: new FakeBearerAuthenticator(),
          authorizer: new RdsAuthorizer(authRepo),
          auditLogger,
          authRepository: authRepo,
          reviewService,
          quarantineService,
        },
        { devUserHeader: false },
      ),
    );
    app.use('/api', apiErrorHandler);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    if (!pool) return;
    vi.restoreAllMocks();
    await pool.query(`DELETE FROM quarantine WHERE project_id = $1`, [projectId]);
    await pool.query(
      `DELETE FROM memory_revision WHERE memory_id IN (SELECT id FROM memory WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM staging_item WHERE session_id IN (SELECT id FROM staging_session WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(`DELETE FROM access_log WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    await pool.query(`DELETE FROM app_user WHERE idp_subject IN ($1, $2)`, [TL, AUTHOR]);
    await pool.end();
  });

  it('(1) a false positive is applied: original author, restore provenance, label recorded', async () => {
    const id = await seed();
    const before = judgeCalls.length;
    const res = await restore(id);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('applied');
    expect(judgeCalls.length - before).toBe(1);

    const mem = (
      await pool.query(
        `SELECT author_identity, origin_branch, origin_pr FROM memory WHERE id = $1`,
        [res.body.memoryId],
      )
    ).rows[0];
    expect(mem).toEqual({ author_identity: AUTHOR, origin_branch: `restore/${id}`, origin_pr: 77 });

    const q = (
      await pool.query(
        `SELECT restored_by, restored_at, restored_item_id FROM quarantine WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(q.restored_by).toBe(tlUserId);
    expect(q.restored_at).not.toBeNull();
    const item = (
      await pool.query(`SELECT promoted_memory_id, session_id FROM staging_item WHERE id = $1`, [
        q.restored_item_id,
      ])
    ).rows[0];
    expect(item.promoted_memory_id).toBe(res.body.memoryId);
    const ss = (
      await pool.query(`SELECT status, branch FROM staging_session WHERE id = $1`, [
        item.session_id,
      ])
    ).rows[0];
    expect(ss).toEqual({ status: 'promoted', branch: `restore/${id}` });

    // (8) one update audit row with ids only.
    const logs = (
      await pool.query(
        `SELECT action, actor_identity, detail FROM access_log
          WHERE project_id = $1 AND detail->>'quarantineId' = $2`,
        [projectId, id],
      )
    ).rows;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'update',
      actor_identity: TL,
      detail: { api: 'quarantine.restore', quarantineId: id, outcome: 'applied' },
    });
  });

  it('(2) a mandatory type is queued and appears in the review queue', async () => {
    const id = await seed({ type: 'decision' });
    const res = await restore(id);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('queued');
    const queue = await request(app)
      .get(`/api/v1/projects/${projectId}/review-queue`)
      .set('Authorization', `Bearer ${TL}`);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toContain(res.body.itemId);
  });

  it.each([
    [
      'secret_detected (spans)',
      {
        body: 'Deploy failed with [REDACTADO] in src/x.ts.',
        reason: 'secret_detected',
        reasonCode: 'secret_detected',
        criterion: 'pipeline',
      },
    ],
    [
      'sanitize_failed',
      { reason: 'sanitize_failed', reasonCode: 'sanitize_failed', criterion: 'pipeline' },
    ],
    [
      'security_second_layer',
      {
        title: '[REDACTADO]',
        summary: '[REDACTADO]',
        body: '[REDACTADO]',
        reason: 'security_second_layer',
        reasonCode: 'secret_detected',
        criterion: 'judge',
      },
    ],
    ['sentinel content, other reason', { body: '[REDACTADO]' }],
  ])('(3) SEC-L3: %s → restore 404, canRestore false, nothing claimed', async (_l, over) => {
    const id = await seed(over);
    const before = judgeCalls.length;
    expect((await restore(id)).status).toBe(404);
    expect(judgeCalls.length).toBe(before);
    const q = (await pool.query(`SELECT restored_at FROM quarantine WHERE id = $1`, [id])).rows[0];
    expect(q.restored_at).toBeNull();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM staging_session WHERE branch = $1`,
      [`restore/${id}`],
    );
    expect(rows[0].n).toBe(0);
    const get = await request(app)
      .get(`/api/v1/projects/${projectId}/quarantine/${id}`)
      .set('Authorization', `Bearer ${TL}`);
    expect(get.status).toBe(200);
    expect(get.body.canRestore).toBe(false);
  });

  it('(9) SEC-L2: an open session already on restore/<id> → opaque 404, not 500', async () => {
    const id = await seed();
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, status)
       VALUES ('01J0RESTORESLOTTAKEN000000', $1, $2, $3, 'squatter', 'open')`,
      [projectId, repoId, `restore/${id}`],
    );
    const res = await restore(id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    const q = (await pool.query(`SELECT restored_at FROM quarantine WHERE id = $1`, [id])).rows[0];
    expect(q.restored_at).toBeNull();
  });

  it('(10) SEC-L5: judgeReason only for the project admin', async () => {
    const id = await seed();
    const asAdmin = await request(app)
      .get(`/api/v1/projects/${projectId}/quarantine/${id}`)
      .set('Authorization', `Bearer ${TL}`);
    expect(asAdmin.body).toMatchObject({ judgeReason: 'specificity', canRestore: true });
    const asAuthor = await request(app)
      .get(`/api/v1/projects/${projectId}/quarantine/${id}`)
      .set('Authorization', `Bearer ${AUTHOR}`);
    expect(asAuthor.status).toBe(200);
    expect(asAuthor.body).not.toHaveProperty('judgeReason');
    expect(asAuthor.body).toMatchObject({
      reasonCode: 'judge_rejected',
      criterion: 'judge',
      canRestore: false,
    });
  });

  it('(4) restore again → 404; GET of the restored row → 404', async () => {
    const id = await seed();
    expect((await restore(id)).status).toBe(200);
    expect((await restore(id)).status).toBe(404);
    const get = await request(app)
      .get(`/api/v1/projects/${projectId}/quarantine/${id}`)
      .set('Authorization', `Bearer ${TL}`);
    expect(get.status).toBe(404);
  });

  it('(5) two concurrent restores → one 200, one 404, exactly one staging item', async () => {
    const id = await seed();
    const statuses = (await Promise.all([restore(id), restore(id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 404]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM staging_item si JOIN staging_session ss ON ss.id = si.session_id
        WHERE ss.branch = $1`,
      [`restore/${id}`],
    );
    expect(rows[0].n).toBe(1);
  });

  it('(6) repo deleted → 404', async () => {
    const id = await seed({ repo: null });
    expect((await restore(id)).status).toBe(404);
  });

  it('(7) amend with a current target → mandatory-free type is applied with the target; moved target → queued stale', async () => {
    const id = await seed({ op: 'amend', target: targetId, targetRevision: 2 });
    const ok = await restore(id);
    expect(ok.body).toMatchObject({ outcome: 'applied', memoryId: targetId });
    const mem = (await pool.query(`SELECT current_revision FROM memory WHERE id = $1`, [targetId]))
      .rows[0];
    expect(mem.current_revision).toBe(3);

    const stale = await seed({ op: 'amend', target: targetId, targetRevision: 2 });
    const res = await restore(stale);
    expect(res.body.outcome).toBe('queued');
    const item = (
      await pool.query(`SELECT judge_criterion FROM staging_item WHERE id = $1`, [res.body.itemId])
    ).rows[0];
    expect(item.judge_criterion).toBe('stale_target');
  });

  it('a non-admin member (author) cannot restore → 404 and nothing is claimed', async () => {
    const id = await seed();
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/quarantine/${id}/restore`)
      .set('Authorization', `Bearer ${AUTHOR}`)
      .send({});
    expect(res.status).toBe(404);
    const q = (await pool.query(`SELECT restored_at FROM quarantine WHERE id = $1`, [id])).rows[0];
    expect(q.restored_at).toBeNull();
  });
});
