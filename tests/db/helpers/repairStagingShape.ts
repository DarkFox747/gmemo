/**
 * The 0002 teardown (memory.migrate suite) drops the staging_op / memory_type
 * enums with CASCADE, which silently removes staging_item.op and .type while the
 * ledger still lists 0003+. Detects that reduced shape and drops the staging
 * tables + ledger rows so the next runMigrations rebuilds them from scratch.
 * Call before runMigrations in any DB suite that writes staging rows and may run
 * after the memory.migrate suite.
 */

import type pg from 'pg';

export async function repairReducedStagingShape(pool: pg.Pool): Promise<void> {
  const { rows: opCol } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'staging_item' AND column_name = 'op'`,
  );
  const { rows: stagingTable } = await pool.query(
    `SELECT to_regclass('staging_item')::text AS name`,
  );
  if (stagingTable[0].name !== null && opCol.length === 0) {
    await pool.query(`
      DROP TABLE IF EXISTS staging_item CASCADE;
      DROP TABLE IF EXISTS staging_session CASCADE;
      DROP TABLE IF EXISTS quarantine CASCADE;
      DROP TYPE IF EXISTS staging_status CASCADE;
      DROP TYPE IF EXISTS judge_state CASCADE;
      DELETE FROM schema_migrations
       WHERE version IN ('0003_staging', '0004_promotion_gaps', '0007_judge_structured_verdict',
                         '0008_quarantine_management');
    `);
  }
}
