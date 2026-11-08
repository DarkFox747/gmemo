/**
 * Migration integration test — 0011_access_log_activity_indexes.sql (C12).
 * SKIPPED when DATABASE_URL is unset. Asserts both partial indexes exist, the ledger
 * records the version, and re-executing the file is a no-op.
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('migration integration — 0011 access_log activity indexes', () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function indexNames(): Promise<string[]> {
    const { rows } = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'access_log' AND indexname IN ('ix_audit_project_activity','ix_audit_job_activity')
        ORDER BY indexname`,
    );
    return rows.map((r) => r.indexname as string);
  }

  it('creates both partial indexes', async () => {
    expect(await indexNames()).toEqual(['ix_audit_job_activity', 'ix_audit_project_activity']);
  });

  it('re-executing the migration is a no-op and the ledger records it', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sql = await fs.readFile(
      path.resolve(dir, '../../migrations/0011_access_log_activity_indexes.sql'),
      'utf8',
    );
    await pool!.query(sql);
    expect(await indexNames()).toEqual(['ix_audit_job_activity', 'ix_audit_project_activity']);
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0011_access_log_activity_indexes'`,
    );
    expect(rows).toHaveLength(1);
  });
});
