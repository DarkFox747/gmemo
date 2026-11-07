/**
 * T246: Migration integration test — 0002_memory.sql
 *
 * SKIPPED when `process.env.DATABASE_URL` is unset (mirrors the 0001 test).
 * When a real Postgres connection string is provided this test:
 *
 *  1. Runs the full migration suite (runMigrations) — includes both 0001 and 0002.
 *  2. Asserts the three memory READ-core tables exist: memory, memory_revision,
 *     memory_relation.
 *  3. Asserts all six enums introduced by 0002 exist in pg_type.
 *  4. Asserts the schema_migrations ledger records the '0002_memory' version.
 *  5. FTS smoke check: inserts a memory row (with a project FK) and asserts the
 *     generated content_tsv column matches a stemmed English query —
 *     proving the 'english' dictionary (D2) + GENERATED ALWAYS column are live.
 *  6. Tears down all 0002 objects (and the test project row) so the suite
 *     stays idempotent even when run multiple times.
 *
 * Prerequisites: Postgres 16, DATABASE_URL set, CREATE privileges on the schema.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Skip guard — entire suite skipped when DATABASE_URL is unset.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb('migration integration — 0002_memory.sql', () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (0001 then 0002, idempotent).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
  });

  afterAll(async () => {
    if (!pool) return;

    // Tear down 0002 objects.  Order matters (FK dependencies).
    await pool.query(`
      DROP TABLE IF EXISTS memory_relation CASCADE;
      DROP TABLE IF EXISTS memory_revision  CASCADE;
      DROP TABLE IF EXISTS memory           CASCADE;
      DROP TYPE IF EXISTS memory_type     CASCADE;
      DROP TYPE IF EXISTS memory_status   CASCADE;
      DROP TYPE IF EXISTS provenance      CASCADE;
      DROP TYPE IF EXISTS staging_op      CASCADE;
      DROP TYPE IF EXISTS relation_type   CASCADE;
      DROP TYPE IF EXISTS relation_src    CASCADE;
    `);

    // Remove the ledger entry so a second run can re-apply the migration.
    await pool.query(`DELETE FROM schema_migrations WHERE version = '0002_memory'`);

    // Tear down the test project row inserted for the FTS smoke check.
    await pool.query(
      `DELETE FROM project WHERE slug = 'memory-integ-test'`,
    );

    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  const EXPECTED_TABLES = ['memory', 'memory_revision', 'memory_relation'];

  for (const tableName of EXPECTED_TABLES) {
    it(`table "${tableName}" exists after 0002 migration`, async () => {
      const { rows } = await pool!.query(
        `SELECT to_regclass($1::text)::text AS exists`,
        [tableName],
      );
      expect(rows[0].exists).toBe(tableName);
    });
  }

  // -------------------------------------------------------------------------
  // Enums
  // -------------------------------------------------------------------------

  const EXPECTED_ENUMS = [
    'memory_type',
    'memory_status',
    'provenance',
    'staging_op',
    'relation_type',
    'relation_src',
  ];

  for (const enumName of EXPECTED_ENUMS) {
    it(`enum "${enumName}" exists after 0002 migration`, async () => {
      const { rows } = await pool!.query(
        `SELECT typname FROM pg_type WHERE typname = $1 AND typtype = 'e'`,
        [enumName],
      );
      expect(rows).toHaveLength(1);
    });
  }

  // -------------------------------------------------------------------------
  // Indexes
  // -------------------------------------------------------------------------

  const EXPECTED_INDEXES = [
    'ix_memory_proj_status_type',
    'ix_memory_ttl',
    'ix_memory_tsv',
  ];

  for (const indexName of EXPECTED_INDEXES) {
    it(`index "${indexName}" exists on table "memory" after 0002 migration`, async () => {
      const { rows } = await pool!.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'memory' AND indexname = $1`,
        [indexName],
      );
      expect(rows).toHaveLength(1);
    });
  }

  // -------------------------------------------------------------------------
  // schema_migrations ledger
  // -------------------------------------------------------------------------

  it('schema_migrations ledger records the 0002_memory version', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0002_memory'`,
    );
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // FTS smoke check — 'english' dictionary + GENERATED ALWAYS column
  // -------------------------------------------------------------------------

  it('content_tsv matches a stemmed English query (english dictionary, D2)', async () => {
    // Insert a project row to satisfy the FK constraint.
    await pool!.query(
      `INSERT INTO project (slug, name)
       VALUES ('memory-integ-test', 'Memory Integration Test')
       ON CONFLICT (slug) DO NOTHING`,
    );

    const { rows: projRows } = await pool!.query(
      `SELECT id FROM project WHERE slug = 'memory-integ-test'`,
    );
    const projectId: string = projRows[0].id as string;

    // Insert a memory row.  The content_tsv column is GENERATED ALWAYS AS STORED.
    await pool!.query(
      `INSERT INTO memory
         (project_id, type, title, summary, body, provenance, author_identity, content_hash)
       VALUES ($1, 'decision', 'Indexing strategies', 'Improve query performance with indexes',
               'We decided to add composite indexes for the main query patterns.',
               'manual_ui', 'integ-test-user', 'integ-test-hash-' || $1)`,
      [projectId],
    );

    // "indexing" stems to "index" under 'english' dictionary.  The query
    // websearch_to_tsquery('english', 'indexes') should match the stored tsvector.
    const { rows } = await pool!.query(
      `SELECT id
         FROM memory
        WHERE project_id = $1
          AND content_tsv @@ websearch_to_tsquery('english', 'indexes')`,
      [projectId],
    );

    expect(rows).toHaveLength(1);

    // Clean up the inserted row (tear-down above removes the project row separately).
    await pool!.query(
      `DELETE FROM memory WHERE project_id = $1`,
      [projectId],
    );
  });
});
