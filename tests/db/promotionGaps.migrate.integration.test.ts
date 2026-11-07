/**
 * T003: Migration integration test — 0004_promotion_gaps.sql
 *
 * SKIPPED when `process.env.DATABASE_URL` is unset (mirrors the 0001–0003 tests).
 * When a real Postgres connection string is provided this test:
 *
 *  1. Runs the full migration suite (runMigrations — 0001 → 0002 → 0003 → 0004).
 *  2. Asserts the two new staging_item columns (promoted_at, promoted_memory_id)
 *     exist and are nullable.
 *  3. Asserts the promoted_memory_id FK uses ON DELETE SET NULL.
 *  4. Asserts 'partially_promoted' is present in the staging_status enum.
 *  5. Asserts the quarantine table exists.
 *  6. Asserts quarantine FKs (project_id CASCADE, repo_id SET NULL).
 *  7. Asserts quarantine indexes (ix_quarantine_project, ix_quarantine_expires partial).
 *  8. Asserts quarantine budget CHECKs reject over-budget inserts; valid insert succeeds.
 *  9. Asserts quarantine row survives deletion of its origin staging_session (CASCADE sweep).
 * 10. Asserts 'partially_promoted' is usable in a later transaction (PG16 ADD VALUE caveat).
 * 11. Asserts re-applying 0004 SQL directly is a no-op (all guards hold).
 * 12. Asserts schema_migrations ledger records '0004_promotion_gaps'.
 *
 * Prerequisites: Postgres 16 reachable at DATABASE_URL with CREATE privileges.
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Skip guard — entire suite is skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const PROJECT_SLUG = 'promotion-gaps-migrate-test';
const REPO_URL = 'https://github.com/test/promotion-gaps-migrate-integ';
const MEMORY_CONTENT_HASH = 'promotion-gaps-migrate-test-hash-v1';
// A valid ULID string (Crockford base32, 26 chars)
const SESSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBV';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithDb('migration integration — 0004_promotion_gaps.sql', () => {
  let pool: pg.Pool | undefined;
  let projectId: string;
  let repoId: string;
  let _memoryId: string;
  let stagingItemId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (0001 → 0004; idempotent).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    // -- Seed: project --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Promotion Gaps Migrate Integration Test')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG],
    );
    const { rows: projRows } = await pool.query(
      `SELECT id FROM project WHERE slug = $1`,
      [PROJECT_SLUG],
    );
    projectId = projRows[0].id as string;

    // -- Seed: repo --
    await pool.query(
      `INSERT INTO repo (project_id, remote_url)
       VALUES ($1, $2)
       ON CONFLICT (remote_url) DO NOTHING`,
      [projectId, REPO_URL],
    );
    const { rows: repoRows } = await pool.query(
      `SELECT id FROM repo WHERE remote_url = $1`,
      [REPO_URL],
    );
    repoId = repoRows[0].id as string;

    // -- Seed: memory row (FK target for promoted_memory_id) --
    await pool.query(
      `INSERT INTO memory
         (project_id, type, title, summary, body, provenance, author_identity, content_hash)
       VALUES ($1, 'decision',
               'Promotion Gaps Test Memory',
               'Seed row for the promotion gaps migration test suite.',
               'This row exists so promoted_memory_id FK tests can use a real memory id.',
               'manual_ui', 'promotion-gaps-integ-user', $2)
       ON CONFLICT (project_id, content_hash) DO NOTHING`,
      [projectId, MEMORY_CONTENT_HASH],
    );
    const { rows: memRows } = await pool.query(
      `SELECT id FROM memory WHERE project_id = $1 AND content_hash = $2`,
      [projectId, MEMORY_CONTENT_HASH],
    );
    _memoryId = memRows[0].id as string;

    // -- Seed: staging session (for quarantine-survives-sweep test) --
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'main', 'promotion-gaps-integ-user')
       ON CONFLICT DO NOTHING`,
      [SESSION_ID, projectId, repoId],
    );

    // -- Seed: staging item inside that session --
    const { rows: itemRows } = await pool.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity)
       VALUES ($1, 'add', 'decision',
               'Promotion Gaps Item Title',
               'Promotion gaps item summary.',
               'Promotion gaps item body.',
               'promotion-gaps-item-hash-v1',
               'promotion-gaps-integ-user')
       ON CONFLICT (session_id, content_hash) DO NOTHING
       RETURNING id`,
      [SESSION_ID],
    );
    if (itemRows.length > 0) {
      stagingItemId = itemRows[0].id as string;
    } else {
      const { rows: existingRows } = await pool.query(
        `SELECT id FROM staging_item WHERE session_id = $1 AND content_hash = $2`,
        [SESSION_ID, 'promotion-gaps-item-hash-v1'],
      );
      stagingItemId = existingRows[0].id as string;
    }
  });

  afterAll(async () => {
    if (!pool) return;

    // Drop the quarantine table (created by 0004).
    await pool.query(`DROP TABLE IF EXISTS quarantine CASCADE`);

    // Remove the ledger entry so a subsequent run can re-apply this migration.
    await pool.query(
      `DELETE FROM schema_migrations WHERE version = '0004_promotion_gaps'`,
    );

    // Delete seeded project row — cascades to repo, memory, staging_session,
    // and staging_item (all ON DELETE CASCADE from project).
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);

    // Note: the added staging_status value and the two staging_item columns are
    // left in place — enum values cannot be dropped; the columns are additive.
    // This is consistent with the forward-only runner and does not affect other suites.

    await pool.end();
  });

  // -------------------------------------------------------------------------
  // 1. New columns on staging_item
  // -------------------------------------------------------------------------

  it('staging_item.promoted_at column exists and is nullable', async () => {
    const { rows } = await pool!.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'staging_item' AND column_name = 'promoted_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('timestamp with time zone');
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('staging_item.promoted_memory_id column exists and is nullable', async () => {
    const { rows } = await pool!.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'staging_item' AND column_name = 'promoted_memory_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('uuid');
    expect(rows[0].is_nullable).toBe('YES');
  });

  // -------------------------------------------------------------------------
  // 2. FK on promoted_memory_id uses ON DELETE SET NULL
  // -------------------------------------------------------------------------

  it('promoted_memory_id FK uses ON DELETE SET NULL (confdeltype = n)', async () => {
    const { rows } = await pool!.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t   ON t.oid  = c.conrelid
         JOIN pg_class ft  ON ft.oid = c.confrelid
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'staging_item'
          AND ft.relname = 'memory'
          AND a.attname = 'promoted_memory_id'
          AND c.contype = 'f'`,
    );
    expect(rows).toHaveLength(1);
    // 'n' = SET NULL in pg_constraint.confdeltype
    expect(rows[0].confdeltype).toBe('n');
  });

  // -------------------------------------------------------------------------
  // 3. 'partially_promoted' is present in staging_status enum
  // -------------------------------------------------------------------------

  it("'partially_promoted' value exists in staging_status enum", async () => {
    const { rows } = await pool!.query(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'staging_status' AND e.enumlabel = 'partially_promoted'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].enumlabel).toBe('partially_promoted');
  });

  // -------------------------------------------------------------------------
  // 4. quarantine table exists
  // -------------------------------------------------------------------------

  it('quarantine table exists', async () => {
    const { rows } = await pool!.query(
      `SELECT to_regclass('quarantine')::text AS exists`,
    );
    expect(rows[0].exists).toBe('quarantine');
  });

  // -------------------------------------------------------------------------
  // 5. quarantine FKs
  // -------------------------------------------------------------------------

  it('quarantine.project_id FK uses ON DELETE CASCADE (confdeltype = c)', async () => {
    const { rows } = await pool!.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t  ON t.oid  = c.conrelid
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'quarantine'
          AND ft.relname = 'project'
          AND a.attname = 'project_id'
          AND c.contype = 'f'`,
    );
    expect(rows).toHaveLength(1);
    // 'c' = CASCADE
    expect(rows[0].confdeltype).toBe('c');
  });

  it('quarantine.repo_id FK uses ON DELETE SET NULL (confdeltype = n)', async () => {
    const { rows } = await pool!.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t  ON t.oid  = c.conrelid
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'quarantine'
          AND ft.relname = 'repo'
          AND a.attname = 'repo_id'
          AND c.contype = 'f'`,
    );
    expect(rows).toHaveLength(1);
    // 'n' = SET NULL
    expect(rows[0].confdeltype).toBe('n');
  });

  // -------------------------------------------------------------------------
  // 6. quarantine indexes
  // -------------------------------------------------------------------------

  it('index ix_quarantine_project exists on quarantine', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'quarantine' AND indexname = 'ix_quarantine_project'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('index ix_quarantine_expires is a partial index (contains WHERE) on quarantine', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'quarantine' AND indexname = 'ix_quarantine_expires'`,
    );
    expect(rows).toHaveLength(1);
    expect((rows[0].indexdef as string).toUpperCase()).toContain('WHERE');
  });

  // -------------------------------------------------------------------------
  // 7. quarantine budget CHECKs
  // -------------------------------------------------------------------------

  it('DB rejects quarantine title longer than 120 chars (ck_quarantine_title_len, code 23514)', async () => {
    const longTitle = 'T'.repeat(121);
    await expect(
      pool!.query(
        `INSERT INTO quarantine
           (project_id, repo_id, op, type, title, summary, body,
            content_hash, judge_reason, author_identity)
         VALUES ($1, $2, 'add', 'decision', $3,
                 'Valid summary.', 'Valid body.',
                 'ck-quarantine-title-hash', 'judge rejected', 'integ-test-user')`,
        [projectId, repoId, longTitle],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('DB rejects quarantine summary longer than 200 chars (ck_quarantine_summary_len, code 23514)', async () => {
    const longSummary = 'S'.repeat(201);
    await expect(
      pool!.query(
        `INSERT INTO quarantine
           (project_id, repo_id, op, type, title, summary, body,
            content_hash, judge_reason, author_identity)
         VALUES ($1, $2, 'add', 'decision', 'Valid title', $3, 'Valid body.',
                 'ck-quarantine-summary-hash', 'judge rejected', 'integ-test-user')`,
        [projectId, repoId, longSummary],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('DB rejects quarantine body longer than 2000 chars (ck_quarantine_body_len, code 23514)', async () => {
    const longBody = 'B'.repeat(2001);
    await expect(
      pool!.query(
        `INSERT INTO quarantine
           (project_id, repo_id, op, type, title, summary, body,
            content_hash, judge_reason, author_identity)
         VALUES ($1, $2, 'add', 'decision', 'Valid title', 'Valid summary.', $3,
                 'ck-quarantine-body-hash', 'judge rejected', 'integ-test-user')`,
        [projectId, repoId, longBody],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('valid quarantine snapshot insert succeeds', async () => {
    const { rows } = await pool!.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, origin_item_id,
          op, type, title, summary, body, content_hash, judge_reason, author_identity)
       VALUES ($1, $2, $3, $4,
               'add', 'decision',
               'Valid quarantine title',
               'Valid quarantine summary.',
               'Valid quarantine body.',
               'ck-valid-quarantine-hash', 'Secrets detected', 'integ-test-user')
       RETURNING id`,
      [projectId, repoId, SESSION_ID, stagingItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 8. Quarantine survives staging sweep (no FK, not orphaned)
  // -------------------------------------------------------------------------

  it('quarantine row survives deletion of its origin staging_session (no FK cascade)', async () => {
    // Create a separate session + quarantine row just for this sweep test.
    const sweepSessionId = '01ARZ3NDEKTSV4RRFFQ69G5FCV';
    await pool!.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'sweep-test', 'promotion-gaps-integ-user')
       ON CONFLICT DO NOTHING`,
      [sweepSessionId, projectId, repoId],
    );

    // Insert a staging_item into the sweep session so the ON DELETE CASCADE path
    // from staging_session → staging_item is exercised when the session is deleted.
    const { rows: sweepItemRows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity)
       VALUES ($1, 'add', 'decision',
               'Sweep staging item title',
               'Sweep staging item summary.',
               'Sweep staging item body.',
               'ck-sweep-staging-item-hash', 'promotion-gaps-integ-user')
       ON CONFLICT (session_id, content_hash) DO NOTHING
       RETURNING id`,
      [sweepSessionId],
    );
    let sweepItemId: string;
    if (sweepItemRows.length > 0) {
      sweepItemId = sweepItemRows[0].id as string;
    } else {
      const { rows: existingSweepRows } = await pool!.query(
        `SELECT id FROM staging_item WHERE session_id = $1 AND content_hash = $2`,
        [sweepSessionId, 'ck-sweep-staging-item-hash'],
      );
      sweepItemId = existingSweepRows[0].id as string;
    }

    const { rows: qRows } = await pool!.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, op, type, title, summary, body,
          content_hash, judge_reason, author_identity)
       VALUES ($1, $2, $3,
               'add', 'decision',
               'Sweep test quarantine title',
               'Sweep test quarantine summary.',
               'Sweep test quarantine body.',
               'ck-sweep-quarantine-hash', 'Secrets detected', 'integ-test-user')
       RETURNING id`,
      [projectId, repoId, sweepSessionId],
    );
    const quarantineId = qRows[0].id as string;

    // Delete the staging session — this cascades to staging_item rows via
    // staging_item.session_id FK ON DELETE CASCADE, but the quarantine row
    // has no FK to staging_session so it must survive.
    await pool!.query(`DELETE FROM staging_session WHERE id = $1`, [sweepSessionId]);

    // (a) staging_item was removed by CASCADE from the session delete.
    const { rows: itemCheckRows } = await pool!.query(
      `SELECT id FROM staging_item WHERE id = $1`,
      [sweepItemId],
    );
    expect(itemCheckRows).toHaveLength(0);

    // (b) quarantine snapshot still exists — it has no FK to staging_session.
    const { rows: checkRows } = await pool!.query(
      `SELECT id FROM quarantine WHERE id = $1`,
      [quarantineId],
    );
    expect(checkRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 9. 'partially_promoted' is usable in a later transaction (PG16 ADD VALUE caveat)
  // -------------------------------------------------------------------------

  it("'partially_promoted' is usable after migration (UPDATE staging_session SET status = 'partially_promoted')", async () => {
    // This UPDATE runs in a NEW transaction (separate from the one that added
    // the value), confirming the PG16 caveat boundary is respected.
    await expect(
      pool!.query(
        `UPDATE staging_session SET status = 'partially_promoted' WHERE id = $1`,
        [SESSION_ID],
      ),
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 10. Idempotent re-apply: running 0004 SQL a second time is a no-op
  // -------------------------------------------------------------------------

  it('re-applying 0004 SQL directly does not throw (all IF NOT EXISTS guards hold)', async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationPath = path.resolve(__dirname, '../../migrations/0004_promotion_gaps.sql');
    const sql = await fs.readFile(migrationPath, 'utf8');

    // Run outside the ledger — raw execution; must not throw.
    await expect(pool!.query(sql)).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 11. schema_migrations ledger records '0004_promotion_gaps'
  // -------------------------------------------------------------------------

  it('schema_migrations ledger records the 0004_promotion_gaps version', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0004_promotion_gaps'`,
    );
    expect(rows).toHaveLength(1);
  });
});
