/**
 * PgQuarantineRepository — integration tests (C3, HU-10). SKIPPED without DATABASE_URL.
 * List / detail visibility, restore claim (R0–R3, first writer wins, D3) and purge.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PgQuarantineRepository } from '../../src/db/quarantineRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG_A = 'quarantine-repo-integ-a';
const SLUG_B = 'quarantine-repo-integ-b';
const SESSION_ID = '01J0QREPOINTEG00000000000A';

describeWithDb('PgQuarantineRepository integration', () => {
  let pool: pg.Pool;
  let repo: PgQuarantineRepository;
  let projectA: string;
  let projectB: string;
  let repoA: string;
  let repoB: string;
  let tlUserId: string;
  let memA: string;
  let memB: string;

  const ADMIN = { isAdmin: true, subject: 'qr-tl' };
  const AUTHOR = { isAdmin: false, subject: 'qr-author' };
  const OTHER = { isAdmin: false, subject: 'qr-other' };

  interface Seed {
    project?: string;
    repo?: string | null;
    author?: string;
    reason?: string;
    reasonCode?: string;
    criterion?: string;
    op?: string;
    target?: string | null;
    targetRevision?: number | null;
    related?: string | null;
    body?: string;
    title?: string;
    ageDays?: number;
    expiresInDays?: number | null;
    restored?: boolean;
    session?: string | null;
  }

  async function seed(s: Seed = {}): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, op, type, title, summary, body, fields,
          content_hash, judge_reason, author_identity, criterion, reason_code,
          related_memory_id, target_memory_id, target_revision, quarantined_at, expires_at, restored_at)
       VALUES ($1, $2, $3, $4, 'pattern', $5, 'Seed summary', $6, '{"k":"v"}'::jsonb,
               'qr-hash', $7, $8, $9::quarantine_criterion, $10::quarantine_reason_code,
               $11, $12, $13, now() - make_interval(days => $14::int),
               CASE WHEN $15::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $15::float8 * 86400) END,
               CASE WHEN $16 THEN now() ELSE NULL END)
       RETURNING id`,
      [
        s.project ?? projectA,
        s.repo === undefined ? repoA : s.repo,
        s.session === undefined ? SESSION_ID : s.session,
        s.op ?? 'add',
        s.title ?? 'Seed title',
        s.body ?? 'Seed body with context and [REDACTADO] inside.',
        s.reason ?? 'specificity',
        s.author ?? 'qr-author',
        s.criterion ?? 'judge',
        s.reasonCode ?? 'judge_rejected',
        s.related ?? null,
        s.target ?? null,
        s.targetRevision ?? null,
        s.ageDays ?? 0,
        s.expiresInDays === undefined ? 60 : s.expiresInDays,
        s.restored ?? false,
      ],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgQuarantineRepository: Repo } = await import('../../src/db/quarantineRepository.js');
    repo = new Repo(pool);

    const mkProject = async (slug: string) =>
      (
        await pool.query(
          `INSERT INTO project (slug, name) VALUES ($1, $1)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [slug],
        )
      ).rows[0].id as string;
    projectA = await mkProject(SLUG_A);
    projectB = await mkProject(SLUG_B);
    const mkRepo = async (p: string, url: string) =>
      (
        await pool.query(
          `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
           ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
          [p, url],
        )
      ).rows[0].id as string;
    repoA = await mkRepo(projectA, 'https://github.com/test/qr-integ-a');
    repoB = await mkRepo(projectB, 'https://github.com/test/qr-integ-b');
    tlUserId = (
      await pool.query(
        `INSERT INTO app_user (idp_subject, email, display_name) VALUES ('qr-tl', 'qr-tl@x.io', 'QR TL')
         ON CONFLICT (idp_subject) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name) VALUES ('qr-author', 'qr-author@x.io', 'QR Author')
       ON CONFLICT (idp_subject) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, pr_number)
       VALUES ($1, $2, $3, 'feat/origin', 'qr-author', 77) ON CONFLICT DO NOTHING`,
      [SESSION_ID, projectA, repoA],
    );
    const mkMem = async (p: string, hash: string) =>
      (
        await pool.query(
          `INSERT INTO memory (project_id, type, title, summary, body, provenance, author_identity, content_hash, current_revision)
           VALUES ($1, 'pattern', 'Related', 'Related summary', 'Related body', 'pr_reviewed', 'x', $2, 2)
           RETURNING id`,
          [p, hash],
        )
      ).rows[0].id as string;
    memA = await mkMem(projectA, 'qr-mem-a');
    memB = await mkMem(projectB, 'qr-mem-b');
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM quarantine WHERE project_id IN ($1, $2)`, [projectA, projectB]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM quarantine WHERE project_id IN ($1, $2)`, [projectA, projectB]);
    // Items first: a cascaded memory delete would null an amend target (ck_item_optarget).
    await pool.query(
      `DELETE FROM staging_item WHERE session_id IN
         (SELECT id FROM staging_session WHERE project_id IN ($1, $2))`,
      [projectA, projectB],
    );
    await pool.query(`DELETE FROM project WHERE slug IN ($1, $2)`, [SLUG_A, SLUG_B]);
    await pool.query(`DELETE FROM app_user WHERE idp_subject IN ('qr-tl', 'qr-author')`);
    await pool.end();
  });

  // ---------------------------------------------------------------- list

  it('list: project-scoped, admin sees all, non-admin only own rows', async () => {
    const own = await seed({ author: 'qr-author' });
    const foreign = await seed({ author: 'qr-other' });
    await seed({ project: projectB, repo: repoB, session: null });

    const admin = await repo.list(projectA, ADMIN, { reason: null, limit: 100 });
    expect(admin.rows.map((r) => r.id).sort()).toEqual([own, foreign].sort());

    const author = await repo.list(projectA, AUTHOR, { reason: null, limit: 100 });
    expect(author.rows.map((r) => r.id)).toEqual([own]);

    const other = await repo.list(projectA, OTHER, { reason: null, limit: 100 });
    expect(other.rows.map((r) => r.id)).toEqual([foreign]);
  });

  it('list: reason filter, restored and expired rows hidden, newest first', async () => {
    const older = await seed({ ageDays: 3 });
    const newer = await seed({ ageDays: 1 });
    const secret = await seed({
      reason: 'secret_detected',
      reasonCode: 'secret_detected',
      criterion: 'pipeline',
    });
    await seed({ restored: true });
    await seed({ expiresInDays: -1 });

    const all = await repo.list(projectA, ADMIN, { reason: null, limit: 100 });
    expect(all.rows.map((r) => r.id)).toEqual([secret, newer, older]);

    const filtered = await repo.list(projectA, ADMIN, { reason: 'secret_detected', limit: 100 });
    expect(filtered.rows.map((r) => r.id)).toEqual([secret]);
    expect(filtered.rows[0]).toMatchObject({
      reasonCode: 'secret_detected',
      criterion: 'pipeline',
    });
  });

  it('list: truncated, excerpt ≤160 and days_until_expiry', async () => {
    await seed({ body: 'x'.repeat(500), expiresInDays: 59.5 });
    await seed({ expiresInDays: null });
    const r = await repo.list(projectA, ADMIN, { reason: null, limit: 1 });
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(1);

    const all = await repo.list(projectA, ADMIN, { reason: null, limit: 10 });
    expect(all.truncated).toBe(false);
    const long = all.rows.find((x) => x.excerpt.startsWith('xxx'))!;
    expect(long.excerpt).toHaveLength(160);
    expect(long.daysUntilExpiry).toBe(60);
    expect(all.rows.find((x) => x !== long)!.daysUntilExpiry).toBeNull();
  });

  // ---------------------------------------------------------------- detail

  it('detail: admin and author see it; another member gets null', async () => {
    const id = await seed({ related: memA });
    const d = await repo.findVisible(projectA, ADMIN, id);
    expect(d).toMatchObject({
      id,
      judgeReason: 'specificity',
      author: 'QR Author',
      originBranch: 'feat/origin',
      originPr: 77,
      fields: { k: 'v' },
      related: { id: memA, title: 'Related', status: 'active', version: 2 },
    });
    expect(await repo.findVisible(projectA, AUTHOR, id)).not.toBeNull();
    expect(await repo.findVisible(projectA, OTHER, id)).toBeNull();
    expect(await repo.findVisible(projectB, ADMIN, id)).toBeNull();
  });

  it('detail: related ref only from the same project; restored/expired → null', async () => {
    const id = await seed({ related: memB });
    expect((await repo.findVisible(projectA, ADMIN, id))!.related).toBeNull();
    const restored = await seed({ restored: true });
    const expired = await seed({ expiresInDays: -1 });
    expect(await repo.findVisible(projectA, ADMIN, restored)).toBeNull();
    expect(await repo.findVisible(projectA, ADMIN, expired)).toBeNull();
  });

  // ---------------------------------------------------------------- claim

  const claim = (quarantineId: string, projectId = projectA) =>
    repo.claimForRestore({
      projectId,
      quarantineId,
      restoredByUserId: tlUserId,
      openedBy: 'qr-tl',
    });

  it('claim: writes session, pending item (original author) and label in one txn', async () => {
    const id = await seed({ body: 'Restorable body' });
    const c = await claim(id);
    expect(c.status).toBe('claimed');
    if (c.status !== 'claimed') return;
    expect(c).toMatchObject({ repoId: repoA, branch: `restore/${id}`, originPr: 77 });

    const s = (await pool.query(`SELECT * FROM staging_session WHERE id = $1`, [c.sessionId]))
      .rows[0];
    expect(s).toMatchObject({
      branch: `restore/${id}`,
      status: 'open',
      opened_by: 'qr-tl',
      pr_number: 77,
    });
    const i = (await pool.query(`SELECT * FROM staging_item WHERE id = $1`, [c.itemId])).rows[0];
    expect(i).toMatchObject({
      session_id: c.sessionId,
      judge_state: 'pending',
      author_identity: 'qr-author',
      body: 'Restorable body',
      op: 'add',
      target_memory_id: null,
    });
    const q = (
      await pool.query(
        `SELECT restored_by, restored_at, restored_item_id FROM quarantine WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(q.restored_by).toBe(tlUserId);
    expect(q.restored_at).not.toBeNull();
    expect(q.restored_item_id).toBe(c.itemId);
  });

  it('claim: second claim → not_found', async () => {
    const id = await seed();
    expect((await claim(id)).status).toBe('claimed');
    expect((await claim(id)).status).toBe('not_found');
  });

  it('claim: concurrent claims → exactly one claimed, one staging item', async () => {
    const id = await seed();
    const results = await Promise.all([claim(id), claim(id)]);
    expect(results.filter((r) => r.status === 'claimed')).toHaveLength(1);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM staging_session WHERE branch = $1`,
      [`restore/${id}`],
    );
    expect(rows[0].n).toBe(1);
  });

  it('claim: repo deleted, non-add without target, expired, other project → not_found', async () => {
    expect((await claim(await seed({ repo: null }))).status).toBe('not_found');
    expect((await claim(await seed({ op: 'amend', target: null }))).status).toBe('not_found');
    expect((await claim(await seed({ expiresInDays: -1 }))).status).toBe('not_found');
    expect((await claim(await seed(), projectB)).status).toBe('not_found');
  });

  it('claim: an amend row is rebuilt with its target and revision', async () => {
    const id = await seed({ op: 'amend', target: memA, targetRevision: 2 });
    const c = await claim(id);
    if (c.status !== 'claimed') throw new Error('expected claimed');
    const i = (
      await pool.query(
        `SELECT op, target_memory_id, target_revision FROM staging_item WHERE id = $1`,
        [c.itemId],
      )
    ).rows[0];
    expect(i).toEqual({ op: 'amend', target_memory_id: memA, target_revision: 2 });
  });

  // ---------------------------------------------------------------- purge

  it('purge: deletes only expires_at < now(), counts per project, keeps NULL expiry', async () => {
    const keep = await seed({ expiresInDays: 1 });
    const keepNull = await seed({ expiresInDays: null });
    await seed({ expiresInDays: -1 });
    await seed({ expiresInDays: -2 });
    await seed({ project: projectB, repo: repoB, session: null, expiresInDays: -1 });

    const counts = await repo.purgeExpired();
    const mine = Object.fromEntries(
      counts
        .filter((c) => c.projectId === projectA || c.projectId === projectB)
        .map((c) => [c.projectId, c.count]),
    );
    expect(mine).toEqual({ [projectA]: 2, [projectB]: 1 });

    const { rows } = await pool.query(
      `SELECT id FROM quarantine WHERE project_id = $1 ORDER BY id`,
      [projectA],
    );
    expect(rows.map((r) => r.id).sort()).toEqual([keep, keepNull].sort());
    expect(await repo.purgeExpired()).toEqual([]);
  });
});
