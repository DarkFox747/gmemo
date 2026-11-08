/**
 * PgMemoryAdminRepository integration tests (C5, HU-13). SKIPPED without DATABASE_URL.
 *
 * List: default active, each status, type, websearch q (filter, not ranking),
 * keyset paging exact under identical microsecond timestamps, project scoping.
 * Detail: any status, author/approver resolution, repo slug. Revisions: newest
 * first, JOIN project guard, 100 cap. Repo lookup: first by created_at, foreign → null.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgMemoryAdminRepository as Repo } from '../../src/db/memoryAdminRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('PgMemoryAdminRepository integration', () => {
  let pool: pg.Pool;
  let repo: Repo;
  let P: string;
  let Q: string;
  let repoP1: string;
  let repoP2: string;
  let repoQ: string;
  let tlId: string;
  let seq = 0;

  async function project(slug: string): Promise<string> {
    await pool.query(`DELETE FROM project WHERE slug = $1`, [slug]);
    const { rows } = await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, $1) RETURNING id`,
      [slug],
    );
    return rows[0].id as string;
  }

  async function repoOf(
    projectId: string,
    url: string,
    slug: string,
    createdAt: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO repo (project_id, remote_url, slug, created_at) VALUES ($1, $2, $3, $4::timestamptz) RETURNING id`,
      [projectId, url, slug, createdAt],
    );
    return rows[0].id as string;
  }

  async function seed(
    p: {
      project?: string;
      status?: string;
      type?: string;
      title?: string;
      body?: string;
      author?: string;
      approvedBy?: string | null;
    } = {},
  ): Promise<string> {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, approved_by)
       VALUES ($1, $2, $3::memory_type, $4, 'Summary', $5, $6::memory_status, 'pr_reviewed', $7, $8, $9)
       RETURNING id`,
      [
        p.project ?? P,
        p.project === Q ? repoQ : repoP1,
        p.type ?? 'gotcha',
        p.title ?? `Admin memory ${seq}`,
        p.body ?? 'Plain body text',
        p.status ?? 'active',
        p.author ?? 'memadmin-unknown-subject',
        `memadmin-hash-${seq}-${Date.now()}`,
        p.approvedBy ?? null,
      ],
    );
    return rows[0].id as string;
  }

  const filter = (over: Partial<Parameters<Repo['listMemories']>[1]> = {}) => ({
    status: 'active' as const,
    type: null,
    q: null,
    cursor: null,
    limit: 20,
    ...over,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgMemoryAdminRepository } = await import('../../src/db/memoryAdminRepository.js');
    repo = new PgMemoryAdminRepository(pool);
    P = await project('memadmin-integ-p');
    Q = await project('memadmin-integ-q');
    await pool.query(`DELETE FROM repo WHERE remote_url LIKE 'https://github.com/test/memadmin-%'`);
    repoP2 = await repoOf(
      P,
      'https://github.com/test/memadmin-p2',
      'test/p2',
      '2026-02-01T00:00:00Z',
    );
    repoP1 = await repoOf(
      P,
      'https://github.com/test/memadmin-p1',
      'test/p1',
      '2026-01-01T00:00:00Z',
    );
    repoQ = await repoOf(Q, 'https://github.com/test/memadmin-q', 'test/q', '2026-01-01T00:00:00Z');
    const { rows } = await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name)
       VALUES ('memadmin-tl', 'memadmin-tl@test.local', 'Tech Lead')
       ON CONFLICT (idp_subject) DO UPDATE SET display_name = 'Tech Lead' RETURNING id`,
    );
    tlId = rows[0].id as string;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project WHERE slug IN ('memadmin-integ-p', 'memadmin-integ-q')`);
    await pool.end();
  });

  it('default active excludes the other statuses; each status filter works; other project never appears', async () => {
    await pool.query(`DELETE FROM memory WHERE project_id IN ($1, $2)`, [P, Q]);
    const ids: Record<string, string> = {};
    for (const s of ['active', 'pending_revalidation', 'superseded', 'deprecated'])
      ids[s] = await seed({ status: s });
    await seed({ project: Q });
    const active = await repo.listMemories(P, filter());
    expect(active.rows.map((r) => r.id)).toEqual([ids.active]);
    expect(active.rows[0]).toMatchObject({
      status: 'active',
      provenance: 'pr_reviewed',
      current_revision: 1,
    });
    expect(active.nextCursor).toBeNull();
    for (const s of ['pending_revalidation', 'superseded', 'deprecated'] as const) {
      expect((await repo.listMemories(P, filter({ status: s }))).rows.map((r) => r.id)).toEqual([
        ids[s],
      ]);
    }
  });

  it('type filter and websearch q (match, negation, phrase, stopwords only → empty)', async () => {
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [P]);
    const pool10 = await seed({
      type: 'decision',
      body: 'The connection pool size must be 30 under burst load',
    });
    const other = await seed({ type: 'decision', body: 'Use structured logging everywhere' });
    await seed({ type: 'gotcha', body: 'pool size bug in the worker' });
    expect(
      (await repo.listMemories(P, filter({ type: 'decision' }))).rows.map((r) => r.id).sort(),
    ).toEqual([pool10, other].sort());
    const ids = async (q: string) =>
      (await repo.listMemories(P, filter({ type: 'decision', q }))).rows.map((r) => r.id);
    expect(await ids('pool size')).toEqual([pool10]);
    expect(await ids('-pool')).toEqual([other]);
    expect(await ids('"pool size must"')).toEqual([pool10]);
    expect(await ids('the and of')).toEqual([]);
  });

  it('45 rows sharing one microsecond → pages 20/20/5 with no gap or duplicate', async () => {
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [P]);
    for (let i = 0; i < 45; i++) await seed();
    await pool.query(
      `UPDATE memory SET updated_at = '2026-05-05T10:00:00.123456Z' WHERE project_id = $1`,
      [P],
    );
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await repo.listMemories(P, filter({ cursor }));
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('newest updated first', async () => {
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [P]);
    const a = await seed();
    const b = await seed();
    await pool.query(`UPDATE memory SET updated_at = now() - interval '1 hour' WHERE id = $1`, [b]);
    expect((await repo.listMemories(P, filter())).rows.map((r) => r.id)).toEqual([a, b]);
  });

  it('a malformed cursor → INVALID_REQUEST', async () => {
    await expect(repo.listMemories(P, filter({ cursor: 'bm9wZQ' }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('detail: any status, author display name only (SEC-L3: no subject/email fallback), approver, repo slug; foreign → null', async () => {
    const known = await seed({ status: 'deprecated', author: 'memadmin-tl', approvedBy: tlId });
    const unknown = await seed({ author: 'memadmin-nobody' });
    const foreign = await seed({ project: Q });
    const d = await repo.findMemory(P, known);
    expect(d).toMatchObject({
      id: known,
      status: 'deprecated',
      author: 'Tech Lead',
      approved_by: tlId,
      approver: 'Tech Lead',
      repo_id: repoP1,
      repo_slug: 'test/p1',
      provenance: 'pr_reviewed',
    });
    expect(d!.created_at).toBeInstanceOf(Date);
    const u = await repo.findMemory(P, unknown);
    expect(u).toMatchObject({ author: null, approved_by: null, approver: null });
    expect(JSON.stringify(u)).not.toContain('memadmin-nobody');
    // A provisioned user without a display name: never falls back to the email.
    await pool.query(
      `INSERT INTO app_user (idp_subject, email) VALUES ('memadmin-emailonly', 'memadmin-emailonly@x.io')
       ON CONFLICT (idp_subject) DO UPDATE SET display_name = NULL`,
    );
    const emailOnly = await seed({ author: 'memadmin-emailonly' });
    const e = await repo.findMemory(P, emailOnly);
    expect(e).toMatchObject({ author: null });
    expect(JSON.stringify(e)).not.toContain('memadmin-emailonly');
    await pool.query(`DELETE FROM app_user WHERE idp_subject = 'memadmin-emailonly'`);
    expect(await repo.findMemory(P, foreign)).toBeNull();
  });

  it('revisions newest first, project-guarded, capped at 100', async () => {
    const id = await seed({ author: 'memadmin-tl' });
    const foreign = await seed({ project: Q });
    for (let n = 1; n <= 101; n++) {
      await pool.query(
        `INSERT INTO memory_revision (memory_id, revision_no, op, title, summary, body, type, content_hash, author_identity)
         VALUES ($1, $2, $3, 't', 's', 'b', 'gotcha', 'h', 'memadmin-tl')`,
        [id, n, n === 1 ? 'add' : 'amend'],
      );
    }
    await pool.query(
      `INSERT INTO memory_revision (memory_id, revision_no, op, title, summary, body, type, content_hash, author_identity)
       VALUES ($1, 1, 'add', 't', 's', 'b', 'gotcha', 'h', 'x')`,
      [foreign],
    );
    const r = await repo.listRevisions(P, id);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(100);
    expect(r.rows[0]).toMatchObject({ revision_no: 101, op: 'amend', author: 'Tech Lead' });
    expect((await repo.listRevisions(P, foreign)).rows).toEqual([]);
  });

  it('findProjectRepoId: null → first repo by created_at; own repo honoured; foreign/unknown → null', async () => {
    expect(await repo.findProjectRepoId(P, null)).toBe(repoP1);
    expect(await repo.findProjectRepoId(P, repoP2)).toBe(repoP2);
    expect(await repo.findProjectRepoId(P, repoQ)).toBeNull();
    expect(await repo.findProjectRepoId(P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11')).toBeNull();
  });
});
