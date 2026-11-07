/**
 * Migration integration test — 0007_judge_structured_verdict.sql
 *
 * SKIPPED when DATABASE_URL is unset (mirrors the other migration tests).
 * Asserts: new columns/types/defaults, CHECK constraints (23514), the
 * review_decision enum, FK ON DELETE SET NULL, idempotent re-apply, ledger row.
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const PROJECT_SLUG = 'judge-verdict-migrate-test';
const REPO_URL = 'https://github.com/test/judge-verdict-migrate-integ';
const SESSION_ID = 'judge-verdict-migrate-sess-01';

describeWithDb('migration integration — 0007_judge_structured_verdict.sql', () => {
  let pool: pg.Pool | undefined;
  let itemId: string;

  async function columnInfo(table: string, column: string) {
    const { rows } = await pool!.query(
      `SELECT data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows[0] as
      | { data_type: string; udt_name: string; is_nullable: string; column_default: string | null }
      | undefined;
  }

  async function insertItem(hash: string): Promise<string> {
    const { rows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity)
       VALUES ($1, 'add', 'pattern', 't', 's', 'b', $2, 'integ-test-user')
       RETURNING id`,
      [SESSION_ID, hash],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, 'Judge Verdict Migrate Test')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG],
    );
    const { rows: proj } = await pool.query(`SELECT id FROM project WHERE slug = $1`, [PROJECT_SLUG]);
    const projectId = proj[0].id as string;
    await pool.query(
      `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
       ON CONFLICT (remote_url) DO NOTHING`,
      [projectId, REPO_URL],
    );
    const { rows: repoRows } = await pool.query(`SELECT id FROM repo WHERE remote_url = $1`, [REPO_URL]);
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'main', 'integ-test-user') ON CONFLICT DO NOTHING`,
      [SESSION_ID, projectId, repoRows[0].id],
    );
    itemId = await insertItem('judge-verdict-migrate-hash-001');
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      `DELETE FROM staging_item WHERE session_id IN
         (SELECT id FROM staging_session WHERE project_id = (SELECT id FROM project WHERE slug = $1))`,
      [PROJECT_SLUG],
    );
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.end();
  });

  it('adds the judge columns with the expected types and nullability', async () => {
    const criterion = await columnInfo('staging_item', 'judge_criterion');
    expect(criterion?.data_type).toBe('text');
    expect(criterion?.is_nullable).toBe('YES');

    const confidence = await columnInfo('staging_item', 'judge_confidence');
    expect(confidence?.data_type).toBe('real');
    expect(confidence?.is_nullable).toBe('YES');

    const mandatory = await columnInfo('staging_item', 'mandatory_review');
    expect(mandatory?.data_type).toBe('boolean');
    expect(mandatory?.is_nullable).toBe('NO');
    expect(mandatory?.column_default).toBe('false');

    expect((await columnInfo('staging_item', 'related_memory_id'))?.data_type).toBe('uuid');
    expect((await columnInfo('staging_item', 'reviewed_by'))?.data_type).toBe('uuid');
    expect((await columnInfo('staging_item', 'review_decision'))?.udt_name).toBe('review_decision');
    expect((await columnInfo('staging_item', 'review_reason'))?.data_type).toBe('text');
    expect((await columnInfo('staging_item', 'reviewed_at'))?.data_type).toBe('timestamp with time zone');
    expect((await columnInfo('memory', 'approved_by'))?.data_type).toBe('uuid');
  });

  it('defaults mandatory_review to false on existing-style inserts', async () => {
    const { rows } = await pool!.query(
      `SELECT mandatory_review, judge_criterion, judge_confidence FROM staging_item WHERE id = $1`,
      [itemId],
    );
    expect(rows[0].mandatory_review).toBe(false);
    expect(rows[0].judge_criterion).toBeNull();
    expect(rows[0].judge_confidence).toBeNull();
  });

  it('creates the review_decision enum with approved and rejected', async () => {
    const { rows } = await pool!.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'review_decision' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['approved', 'rejected']);
  });

  it('rejects judge_confidence outside [0,1] with a check violation', async () => {
    await expect(
      pool!.query(`UPDATE staging_item SET judge_confidence = 1.5 WHERE id = $1`, [itemId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool!.query(`UPDATE staging_item SET judge_confidence = -0.1 WHERE id = $1`, [itemId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool!.query(`UPDATE staging_item SET judge_confidence = 0.8 WHERE id = $1`, [itemId]),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown judge_criterion and accepts every allowed value', async () => {
    await expect(
      pool!.query(`UPDATE staging_item SET judge_criterion = 'foo' WHERE id = $1`, [itemId]),
    ).rejects.toMatchObject({ code: '23514' });

    for (const c of [
      'specificity', 'duplication', 'contradiction', 'grounding',
      'confidence', 'security_second_layer', 'stale_target',
    ]) {
      await expect(
        pool!.query(`UPDATE staging_item SET judge_criterion = $2 WHERE id = $1`, [itemId, c]),
      ).resolves.toBeDefined();
    }
  });

  it('uses ON DELETE SET NULL for related_memory_id, reviewed_by and approved_by', async () => {
    const { rows } = await pool!.query(
      `SELECT a.attname AS col, c.confdeltype
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f'
          AND ((c.conrelid = 'staging_item'::regclass AND a.attname IN ('related_memory_id','reviewed_by'))
            OR (c.conrelid = 'memory'::regclass AND a.attname = 'approved_by'))`,
    );
    const byCol = Object.fromEntries(rows.map((r) => [r.col, r.confdeltype]));
    expect(byCol).toEqual({ related_memory_id: 'n', reviewed_by: 'n', approved_by: 'n' });
  });

  it('re-applying 0007 SQL directly does not throw', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sql = await fs.readFile(
      path.resolve(dir, '../../migrations/0007_judge_structured_verdict.sql'),
      'utf8',
    );
    await expect(pool!.query(sql)).resolves.not.toThrow();
  });

  it('records 0007_judge_structured_verdict in schema_migrations', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0007_judge_structured_verdict'`,
    );
    expect(rows).toHaveLength(1);
  });
});
