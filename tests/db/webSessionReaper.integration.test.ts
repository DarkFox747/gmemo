/**
 * web-session-reaper over Postgres (C5 SEC-M1): only `web/%` sessions still
 * `open` and older than the cutoff are abandoned, and only their non-promoted
 * items are deleted. The script entry point runs the same function and audits
 * it (trigger 'script'). SKIPPED without DATABASE_URL.
 */

import pg from 'pg';
import { repairReducedStagingShape } from './helpers/repairStagingShape.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'web-session-reaper-integ';
const REPO_URL = 'https://github.com/test/web-session-reaper-integ';
const PREFIX = '01JREAPER';

describeWithDb('web-session-reaper (SEC-M1)', () => {
  let pool: pg.Pool;
  let projectId: string;
  let repoId: string;

  /** Inserts a session `age` minutes old with one non-promoted and (optionally) one promoted item. */
  async function seed(
    suffix: string,
    branch: string,
    ageMinutes: number,
    status = 'open',
    withPromoted = false,
  ): Promise<string> {
    const id = `${PREFIX}${suffix}`.padEnd(26, '0');
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, created_at)
       VALUES ($1, $2, $3, $4, $5::staging_status, 'reaper-tl', now() - make_interval(mins => $6::int))`,
      [id, projectId, repoId, branch, status, ageMinutes],
    );
    const item = (n: string, promoted: boolean) =>
      pool.query(
        `INSERT INTO staging_item (session_id, op, type, title, summary, body, content_hash, author_identity, promoted_at)
         VALUES ($1, 'add', 'gotcha', 'Reaper title', 'Reaper summary.', 'Reaper body.', $2, 'reaper-tl',
                 CASE WHEN $3::boolean THEN now() ELSE NULL END)`,
        [id, `reaper-${suffix}-${n}`, promoted],
      );
    await item('pending', false);
    if (withPromoted) await item('promoted', true);
    return id;
  }

  async function state(id: string): Promise<{ status: string; items: number; promoted: number }> {
    const { rows } = await pool.query(
      `SELECT ss.status,
              (SELECT count(*)::int FROM staging_item si WHERE si.session_id = ss.id) AS items,
              (SELECT count(*)::int FROM staging_item si WHERE si.session_id = ss.id AND si.promoted_at IS NOT NULL) AS promoted
       FROM staging_session ss WHERE ss.id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await repairReducedStagingShape(pool);
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    projectId = (
      await pool.query(`INSERT INTO project (slug, name) VALUES ($1, 'Reaper') RETURNING id`, [
        SLUG,
      ])
    ).rows[0].id;
    repoId = (
      await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
         ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
        [projectId, REPO_URL],
      )
    ).rows[0].id;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM staging_session WHERE project_id = $1`, [projectId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM staging_session WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    await pool.end();
  });

  it('abandons only old open web sessions and deletes only their non-promoted items', async () => {
    const stale = await seed('A', 'web/u-1/01JSTALEA', 10, 'open', true);
    const fresh = await seed('B', 'web/u-1/01JFRESHB', 1);
    const agent = await seed('C', 'feat/old-branch', 60);
    const restore = await seed('D', 'restore/q-1', 60);
    const finalized = await seed('E', 'web/u-1/01JDONEE', 60, 'promoted');

    const { PgStagingRepository } = await import('../../src/db/stagingRepository.js');
    const { reapStaleWebSessions } = await import('../../src/memory/webSessionReaper.js');
    const result = await reapStaleWebSessions(new PgStagingRepository(pool));
    expect(result.job).toBe('web-session-reaper');
    expect(result.detail?.[projectId]).toBe(1);

    expect(await state(stale)).toEqual({ status: 'abandoned', items: 1, promoted: 1 });
    expect(await state(fresh)).toEqual({ status: 'open', items: 1, promoted: 0 });
    expect(await state(agent)).toEqual({ status: 'open', items: 1, promoted: 0 });
    expect(await state(restore)).toEqual({ status: 'open', items: 1, promoted: 0 });
    expect(await state(finalized)).toEqual({ status: 'promoted', items: 1, promoted: 0 });

    // Idempotent: a second run finds nothing in this project.
    const again = await reapStaleWebSessions(new PgStagingRepository(pool));
    expect(again.detail?.[projectId]).toBeUndefined();
  });

  it('the script entry point reaps and audits with trigger script (counts only)', async () => {
    const stale = await seed('F', 'web/u-2/01JSTALEF', 30);
    const { runWebSessionReaper } = await import('../../scripts/jobs/web-session-reaper.js');
    const result = await runWebSessionReaper(DATABASE_URL!);
    expect(result.detail?.[projectId]).toBe(1);
    expect(await state(stale)).toEqual({ status: 'abandoned', items: 0, promoted: 0 });
    const { rows } = await pool.query(
      `SELECT actor_identity, detail FROM access_log
       WHERE detail->>'job' = 'web-session-reaper' AND detail->>'trigger' = 'script'
       ORDER BY ts DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ actor_identity: 'jobs:script' });
    expect(rows[0].detail.detail[projectId]).toBe(1);
  });
});
