/**
 * Migration integration test — 0009_memory_enum_values.sql + 0010_memory_lifecycle.sql (C4).
 *
 * SKIPPED when DATABASE_URL is unset. Asserts: enum values present; columns,
 * CHECK and both partial indexes exist; the backfill touches active non-outcome
 * rows only; re-executing both files is a no-op; ledger rows recorded.
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const PROJECT_SLUG = 'lifecycle-migrate-test';

async function readMigration(file: string): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFile(path.resolve(dir, '../../migrations', file), 'utf8');
}

describeWithDb('migration integration — 0009 + 0010 memory lifecycle', () => {
  let pool: pg.Pool | undefined;
  let projectId: string;
  const ids: Record<string, string> = {};

  async function insertMemory(key: string, type: string, status: string): Promise<void> {
    const { rows } = await pool!.query(
      `INSERT INTO memory (project_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash)
       VALUES ($1, $2, 't', 's', 'b', $3, 'pr_reviewed', 'mig-user', $4)
       RETURNING id`,
      [projectId, type, status, `lc-mig-${key}`],
    );
    ids[key] = rows[0].id as string;
  }

  async function revalidateAt(key: string): Promise<Date | null> {
    const { rows } = await pool!.query(`SELECT revalidate_at FROM memory WHERE id = $1`, [
      ids[key],
    ]);
    return rows[0].revalidate_at as Date | null;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    projectId = (
      await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, 'Lifecycle Migrate Test')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [PROJECT_SLUG],
      )
    ).rows[0].id;
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [projectId]);

    // Legacy-shaped rows (revalidate_at NULL), then re-run 0010 to exercise the backfill.
    await insertMemory('activeDecision', 'decision', 'active');
    await insertMemory('activeOutcome', 'outcome', 'active');
    await insertMemory('deprecatedDecision', 'decision', 'deprecated');
    await pool.query(await readMigration('0010_memory_lifecycle.sql'));
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.end();
  });

  async function labels(t: string): Promise<string[]> {
    const { rows } = await pool!.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [t],
    );
    return rows.map((r) => r.enumlabel as string);
  }

  it('adds pending_revalidation and web_ui enum values', async () => {
    expect(await labels('memory_status')).toContain('pending_revalidation');
    expect(await labels('provenance')).toContain('web_ui');
  });

  it('adds the nullable revalidate_at and retired_reason columns', async () => {
    const { rows } = await pool!.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'memory' AND column_name IN ('revalidate_at', 'retired_reason')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'retired_reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'revalidate_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
  });

  it('CHECK rejects a 2-char retired_reason and accepts 3', async () => {
    await expect(
      pool!.query(`UPDATE memory SET retired_reason = 'ab' WHERE id = $1`, [
        ids.deprecatedDecision,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool!.query(`UPDATE memory SET retired_reason = 'abc' WHERE id = $1`, [
        ids.deprecatedDecision,
      ]),
    ).resolves.toBeDefined();
  });

  it('creates both partial indexes', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('ix_memory_proj_origin_pr', 'ix_memory_revalidate_due')
        ORDER BY indexname`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].indexdef).toMatch(/WHERE \(origin_pr IS NOT NULL\)/);
    expect(rows[1].indexdef).toMatch(/WHERE \(status = 'active'::memory_status\)/);
  });

  it('backfills active non-outcome rows only (~now + 60 days)', async () => {
    const d = await revalidateAt('activeDecision');
    expect(d).not.toBeNull();
    const days = (d!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
    expect(await revalidateAt('activeOutcome')).toBeNull();
    expect(await revalidateAt('deprecatedDecision')).toBeNull();
  });

  it('re-executing 0009 and 0010 is a no-op', async () => {
    const snapshot = async () =>
      (
        await pool!.query(
          `SELECT id, revalidate_at, retired_reason FROM memory WHERE project_id = $1 ORDER BY id`,
          [projectId],
        )
      ).rows;
    const before = await snapshot();
    const statusBefore = await labels('memory_status');
    await pool!.query(await readMigration('0009_memory_enum_values.sql'));
    await pool!.query(await readMigration('0010_memory_lifecycle.sql'));
    expect(await snapshot()).toEqual(before);
    expect(await labels('memory_status')).toEqual(statusBefore);
  });

  it('records both versions in schema_migrations', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations
        WHERE version IN ('0009_memory_enum_values', '0010_memory_lifecycle') ORDER BY version`,
    );
    expect(rows.map((r) => r.version)).toEqual([
      '0009_memory_enum_values',
      '0010_memory_lifecycle',
    ]);
  });
});
