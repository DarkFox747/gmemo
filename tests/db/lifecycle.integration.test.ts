/**
 * PgLifecycleRepository integration tests (C4, HU-12.1–12.4, HU-11.4).
 *
 * SKIPPED when DATABASE_URL is unset. Covers list, confirm, retire, retire-by-PR
 * (project predicate) and the sweep against real PG row locks. The sweep is
 * project-agnostic, so assertions only look at this suite's own projects.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgLifecycleRepository as Repo } from '../../src/db/lifecycleRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG_P = 'lifecycle-integ-p';
const SLUG_Q = 'lifecycle-integ-q';
const ACTOR = 'sub-lifecycle-tl';
const DAY_MS = 86_400_000;

describeWithDb('PgLifecycleRepository integration', () => {
  let pool: pg.Pool;
  let repo: Repo;
  let P: string;
  let Q: string;
  let seq = 0;

  interface Seed {
    project?: string;
    type?: string;
    status?: string;
    originPr?: number | null;
    /** SQL interval relative to now(), e.g. '-1 day'; null → NULL. */
    due?: string | null;
  }

  async function seed(s: Seed = {}): Promise<string> {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, origin_pr, revalidate_at)
       VALUES ($1, $2, $3, 'Lifecycle summary', 'Lifecycle body', $4, 'pr_reviewed',
               'seed-user', $5, $6,
               CASE WHEN $7::text IS NULL THEN NULL ELSE now() + $7::interval END)
       RETURNING id`,
      [
        s.project ?? P,
        s.type ?? 'gotcha',
        `Lifecycle memory ${seq}`,
        s.status ?? 'active',
        `lifecycle-integ-${seq}-${Date.now()}`,
        s.originPr ?? null,
        s.due === undefined ? '30 days' : s.due,
      ],
    );
    return rows[0].id as string;
  }

  async function row(id: string) {
    const { rows } = await pool.query(
      `SELECT status, current_revision, revalidate_at, retired_reason, updated_at, reviewed_at,
              title, summary, body, type, content_hash
         FROM memory WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function revisions(id: string) {
    const { rows } = await pool.query(
      `SELECT revision_no, op, title, summary, body, type, content_hash, author_identity,
              promoted_from_item
         FROM memory_revision WHERE memory_id = $1 ORDER BY revision_no`,
      [id],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgLifecycleRepository } = await import('../../src/db/lifecycleRepository.js');
    repo = new PgLifecycleRepository(pool, { revalidationDays: 60 });

    const proj = async (slug: string): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, $1)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [slug],
      );
      await pool.query(`DELETE FROM memory WHERE project_id = $1`, [rows[0].id]);
      return rows[0].id as string;
    };
    P = await proj(SLUG_P);
    Q = await proj(SLUG_Q);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM project WHERE slug IN ($1, $2)`, [SLUG_P, SLUG_Q]);
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  // Sweep (HU-12.1, HU-12.4)
  // ---------------------------------------------------------------------------

  it('sweep moves expired active rows to pending, counted per project; idempotent', async () => {
    const expiredP = await seed({ type: 'decision', due: '-1 day' });
    const expiredQ = await seed({ project: Q, due: '-2 days' });
    const outcome = await seed({ type: 'outcome', due: '-1 day' }); // forced past value
    const future = await seed({ due: '5 days' });
    const noDeadline = await seed({ due: null });
    const deprecated = await seed({ status: 'deprecated', due: '-1 day' });
    const before = await row(expiredP);

    const first = await repo.sweepExpired();
    const byProject = Object.fromEntries(first.map((r) => [r.projectId, r.count]));
    expect(byProject[P]).toBe(1);
    expect(byProject[Q]).toBe(1);

    const after = await row(expiredP);
    expect(after.status).toBe('pending_revalidation');
    // Content unchanged: deadline and updated_at stay as they were.
    expect(after.revalidate_at).toEqual(before.revalidate_at);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.current_revision).toBe(before.current_revision);
    expect((await row(expiredQ)).status).toBe('pending_revalidation');
    expect((await row(outcome)).status).toBe('active');
    expect((await row(future)).status).toBe('active');
    expect((await row(noDeadline)).status).toBe('active');
    expect((await row(deprecated)).status).toBe('deprecated');

    const second = await repo.sweepExpired();
    expect(second.find((r) => r.projectId === P || r.projectId === Q)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  it('list returns only the project pending rows, ordered by deadline then id, with truncation', async () => {
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [P]);
    const late = await seed({ status: 'pending_revalidation', due: '-1 day' });
    const early = await seed({ status: 'pending_revalidation', due: '-10 days' });
    const none = await seed({ status: 'pending_revalidation', due: null });
    await seed({ status: 'active' });
    await seed({ project: Q, status: 'pending_revalidation' });

    const all = await repo.listMemories(P, { status: 'pending_revalidation', limit: 10 });
    expect(all.truncated).toBe(false);
    expect(all.rows.map((r) => r.id)).toEqual([early, late, none]);
    expect(all.rows[0]).toMatchObject({
      status: 'pending_revalidation',
      type: 'gotcha',
      current_revision: 1,
      origin_branch: null,
      origin_pr: null,
    });
    expect(all.rows[0]!.revalidate_at).toBeInstanceOf(Date);
    expect(all.rows[0]!.updated_at).toBeInstanceOf(Date);

    const page = await repo.listMemories(P, { status: 'pending_revalidation', limit: 2 });
    expect(page.truncated).toBe(true);
    expect(page.rows.map((r) => r.id)).toEqual([early, late]);
  });

  // ---------------------------------------------------------------------------
  // Confirm (HU-12.2)
  // ---------------------------------------------------------------------------

  it('confirm: pending → active with a new deadline; revision unchanged; reviewed_at set', async () => {
    const id = await seed({ status: 'pending_revalidation', due: '-3 days' });
    const r = await repo.confirm(P, id);
    expect(r?.memoryId).toBe(id);
    const days = (r!.revalidateAt!.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);

    const after = await row(id);
    expect(after.status).toBe('active');
    expect(after.current_revision).toBe(1);
    expect(after.reviewed_at).not.toBeNull();
    expect(await revisions(id)).toEqual([]);

    // Repeat (now active) → null.
    expect(await repo.confirm(P, id)).toBeNull();
  });

  it('confirm: active, deprecated, foreign and unknown → null', async () => {
    const active = await seed();
    const deprecated = await seed({ status: 'deprecated' });
    const foreign = await seed({ project: Q, status: 'pending_revalidation' });
    expect(await repo.confirm(P, active)).toBeNull();
    expect(await repo.confirm(P, deprecated)).toBeNull();
    expect(await repo.confirm(P, foreign)).toBeNull();
    expect(await repo.confirm(P, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11')).toBeNull();
    expect((await row(foreign)).status).toBe('pending_revalidation');
  });

  it('confirm: an outcome gets no deadline', async () => {
    const id = await seed({ type: 'outcome', status: 'pending_revalidation', due: null });
    expect((await repo.confirm(P, id))?.revalidateAt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Retire (HU-12.3)
  // ---------------------------------------------------------------------------

  it('retire from active: deprecated, reason stored, revision snapshot, deadline cleared', async () => {
    const id = await seed();
    const before = await row(id);
    const r = await repo.retire(P, id, 'obsolete after migration', ACTOR);
    expect(r).toEqual({ memoryId: id, revision: 2 });

    const after = await row(id);
    expect(after).toMatchObject({
      status: 'deprecated',
      current_revision: 2,
      retired_reason: 'obsolete after migration',
      revalidate_at: null,
    });
    expect(await revisions(id)).toEqual([
      {
        revision_no: 2,
        op: 'deprecate',
        title: before.title,
        summary: before.summary,
        body: before.body,
        type: before.type,
        content_hash: before.content_hash,
        author_identity: ACTOR,
        promoted_from_item: null,
      },
    ]);
  });

  it('retire from pending works the same way', async () => {
    const id = await seed({ status: 'pending_revalidation', due: '-1 day' });
    expect(await repo.retire(P, id, 'no longer true', ACTOR)).toEqual({
      memoryId: id,
      revision: 2,
    });
    expect((await row(id)).status).toBe('deprecated');
  });

  it('retire on deprecated, superseded or foreign rows → null with no revision', async () => {
    for (const s of [{ status: 'deprecated' }, { status: 'superseded' }, { project: Q }]) {
      const id = await seed(s);
      expect(await repo.retire(P, id, 'should not apply', ACTOR)).toBeNull();
      expect(await revisions(id)).toEqual([]);
    }
  });

  it('concurrent retire ×2 → exactly one wins and one revision is written', async () => {
    const id = await seed();
    const results = await Promise.all([
      repo.retire(P, id, 'first concurrent', ACTOR),
      repo.retire(P, id, 'second concurrent', ACTOR),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await revisions(id)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Retire by PR (HU-11.4)
  // ---------------------------------------------------------------------------

  it('retire-by-pr retires active + pending of PR 42 in P only, one revision each; repeat → 0', async () => {
    const a1 = await seed({ originPr: 42 });
    const a2 = await seed({ originPr: 42 });
    const pend = await seed({ originPr: 42, status: 'pending_revalidation', due: '-1 day' });
    const dep = await seed({ originPr: 42, status: 'deprecated' });
    const pr43 = await seed({ originPr: 43 });
    const otherProject = await seed({ project: Q, originPr: 42 });

    const r = await repo.retireByPr(P, 42, 'reverted PR 42', ACTOR);
    expect(r.retired).toBe(3);
    expect([...r.memoryIds].sort()).toEqual([a1, a2, pend].sort());

    for (const id of [a1, a2, pend]) {
      const after = await row(id);
      expect(after).toMatchObject({ status: 'deprecated', retired_reason: 'reverted PR 42' });
      const revs = await revisions(id);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({ revision_no: 2, op: 'deprecate', author_identity: ACTOR });
    }
    expect((await row(dep)).retired_reason).toBeNull();
    expect(await revisions(dep)).toEqual([]);
    expect((await row(pr43)).status).toBe('active');
    expect((await row(otherProject)).status).toBe('active');

    expect(await repo.retireByPr(P, 42, 'reverted PR 42', ACTOR)).toEqual({
      retired: 0,
      memoryIds: [],
    });
    for (const id of [a1, a2, pend]) expect(await revisions(id)).toHaveLength(1);
  });

  it('the CHECK backstops an out-of-budget reason', async () => {
    const id = await seed();
    await expect(repo.retire(P, id, 'x'.repeat(501), ACTOR)).rejects.toMatchObject({
      code: '23514',
    });
    expect((await row(id)).status).toBe('active');
  });
});
