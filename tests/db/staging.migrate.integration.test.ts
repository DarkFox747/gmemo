/**
 * T027: Migration integration test — 0003_staging.sql
 *
 * SKIPPED when `process.env.DATABASE_URL` is unset (mirrors the 0001/0002 tests).
 * When a real Postgres connection string is provided this test:
 *
 *  1. Runs the full migration suite (runMigrations — 0001 → 0002 → 0003).
 *  2. Asserts staging_session + staging_item tables exist.
 *  3. Asserts the three enums introduced by 0003 (staging_status, judge_state,
 *     staging_op) exist in pg_type.
 *  4. Asserts all four indexes exist, including the ux_session_open partial
 *     unique index (verified by checking the WHERE clause in indexdef).
 *  5. Asserts the schema_migrations ledger records '0003_staging'.
 *  6. Verifies all DB-level constraint rejections:
 *     — op='add' with a target_memory_id (ck_item_optarget)
 *     — op='amend' without target_memory_id (ck_item_optarget)
 *     — NULL title (NOT NULL)
 *     — NULL summary (NOT NULL)
 *     — title > 120 chars (ck_item_title_len)
 *     — summary > 200 chars (ck_item_summary_len)
 *     — body > 2000 chars (ck_item_body_len)
 *     — second 'open' session for the same (project, repo, branch) (ux_session_open)
 *     — duplicate (session_id, content_hash) (UNIQUE constraint)
 *  7. Tears down 0003 objects idempotently (drops tables, enums, ledger entry,
 *     and the seeded project row — which cascades to repo + memory).
 *
 * Prerequisites: Postgres 16 reachable at DATABASE_URL with CREATE privileges.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Skip guard — entire suite is skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const PROJECT_SLUG = 'staging-migrate-test';
const REPO_URL = 'https://github.com/test/staging-migrate-integ';
const MEMORY_CONTENT_HASH = 'staging-migrate-test-hash-v1';
// Two valid ULID strings (Crockford base32, 26 chars, no I/L/O/U)
const SESSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION_ID_DUP = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithDb('migration integration — 0003_staging.sql', () => {
  let pool: pg.Pool | undefined;
  let projectId: string;
  let repoId: string;
  let memoryId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (0001 → 0002 → 0003; idempotent).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    // -- Seed: project --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Staging Migrate Integration Test')
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

    // -- Seed: memory row (needed as FK target for ck_item_optarget test) --
    await pool.query(
      `INSERT INTO memory
         (project_id, type, title, summary, body, provenance, author_identity, content_hash)
       VALUES ($1, 'decision',
               'Staging Test Memory',
               'Seed row for the staging migration test suite.',
               'This row exists so the op=add+target FK test can use a real memory id.',
               'manual_ui', 'staging-migrate-integ-user', $2)
       ON CONFLICT (project_id, content_hash) DO NOTHING`,
      [projectId, MEMORY_CONTENT_HASH],
    );
    const { rows: memRows } = await pool.query(
      `SELECT id FROM memory WHERE project_id = $1 AND content_hash = $2`,
      [projectId, MEMORY_CONTENT_HASH],
    );
    memoryId = memRows[0].id as string;

    // -- Seed: staging session for constraint tests --
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'main', 'staging-migrate-integ-user')
       ON CONFLICT DO NOTHING`,
      [SESSION_ID, projectId, repoId],
    );
  });

  afterAll(async () => {
    if (!pool) return;

    // Drop 0003 tables (CASCADE removes all rows + child FKs).
    await pool.query(`
      DROP TABLE IF EXISTS staging_item    CASCADE;
      DROP TABLE IF EXISTS staging_session CASCADE;
    `);

    // Drop 0003-specific enums.
    // staging_op is owned by 0002 — intentionally NOT dropped here.
    await pool.query(`
      DROP TYPE IF EXISTS staging_status CASCADE;
      DROP TYPE IF EXISTS judge_state    CASCADE;
    `);

    // Remove the ledger entry so a subsequent run can re-apply this migration.
    await pool.query(
      `DELETE FROM schema_migrations WHERE version = '0003_staging'`,
    );
    // 0004 alters staging_item, which was just dropped; clear its ledger entry
    // too so later suites re-apply it on top of a fresh 0003.
    await pool.query(
      `DELETE FROM schema_migrations WHERE version = '0004_promotion_gaps'`,
    );
    // 0007 also alters staging_item; same reasoning.
    await pool.query(
      `DELETE FROM schema_migrations WHERE version = '0007_judge_structured_verdict'`,
    );

    // Delete seeded project row — cascades to repo and memory (both ON DELETE CASCADE).
    await pool.query(
      `DELETE FROM project WHERE slug = $1`,
      [PROJECT_SLUG],
    );

    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  const EXPECTED_TABLES = ['staging_session', 'staging_item'];

  for (const tableName of EXPECTED_TABLES) {
    it(`table "${tableName}" exists after 0003 migration`, async () => {
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

  const EXPECTED_ENUMS = ['staging_status', 'judge_state', 'staging_op'];

  for (const enumName of EXPECTED_ENUMS) {
    it(`enum "${enumName}" exists after 0003 migration`, async () => {
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

  it('partial unique index ux_session_open exists on staging_session with WHERE clause', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE tablename = 'staging_session' AND indexname = 'ux_session_open'`,
    );
    expect(rows).toHaveLength(1);
    // Verify it is a partial index (WHERE clause present in definition).
    expect((rows[0].indexdef as string).toUpperCase()).toContain('WHERE');
  });

  it('index ix_session_status exists on staging_session', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'staging_session' AND indexname = 'ix_session_status'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('index ix_item_session exists on staging_item', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'staging_item' AND indexname = 'ix_item_session'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('index ix_item_judge exists on staging_item', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'staging_item' AND indexname = 'ix_item_judge'`,
    );
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // schema_migrations ledger
  // -------------------------------------------------------------------------

  it('schema_migrations ledger records the 0003_staging version', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0003_staging'`,
    );
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Constraint: ck_item_optarget — op='add' WITH target_memory_id
  //
  // The CHECK requires (op='add' AND target_memory_id IS NULL).
  // Providing a real memory_id ensures the FK is satisfied so only the
  // CHECK violation fires (code 23514).
  // -------------------------------------------------------------------------

  it('DB rejects op=add with a target_memory_id (ck_item_optarget, code 23514)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash,
            target_memory_id, author_identity)
         VALUES ($1, 'add', 'decision',
                 'Constraint test title', 'Constraint test summary', 'Constraint test body.',
                 'ck-optarget-add-with-target', $2, 'integ-test-user')`,
        [SESSION_ID, memoryId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // Constraint: ck_item_optarget — op='amend' WITHOUT target_memory_id
  //
  // The CHECK requires (op<>'add' AND target_memory_id IS NOT NULL).
  // Omitting target_memory_id (defaults to NULL) violates the constraint.
  // -------------------------------------------------------------------------

  it('DB rejects op=amend without target_memory_id (ck_item_optarget, code 23514)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'amend', 'decision',
                 'Constraint test title', 'Constraint test summary', 'Constraint test body.',
                 'ck-optarget-amend-no-target', 'integ-test-user')`,
        [SESSION_ID],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // Constraint: NOT NULL — title
  // -------------------------------------------------------------------------

  it('DB rejects NULL title (NOT NULL, code 23502)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision',
                 NULL, 'Test summary', 'Test body.',
                 'ck-null-title', 'integ-test-user')`,
        [SESSION_ID],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  // -------------------------------------------------------------------------
  // Constraint: NOT NULL — summary
  // -------------------------------------------------------------------------

  it('DB rejects NULL summary (NOT NULL, code 23502)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision',
                 'Test title', NULL, 'Test body.',
                 'ck-null-summary', 'integ-test-user')`,
        [SESSION_ID],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  // -------------------------------------------------------------------------
  // Constraint: ck_item_title_len — title > 120 chars
  // -------------------------------------------------------------------------

  it('DB rejects title longer than 120 characters (ck_item_title_len, code 23514)', async () => {
    const longTitle = 'T'.repeat(121);
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision', $2, 'Test summary', 'Test body.',
                 'ck-title-over-budget', 'integ-test-user')`,
        [SESSION_ID, longTitle],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // Constraint: ck_item_summary_len — summary > 200 chars
  // -------------------------------------------------------------------------

  it('DB rejects summary longer than 200 characters (ck_item_summary_len, code 23514)', async () => {
    const longSummary = 'S'.repeat(201);
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision', 'Test title', $2, 'Test body.',
                 'ck-summary-over-budget', 'integ-test-user')`,
        [SESSION_ID, longSummary],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // Constraint: ck_item_body_len — body > 2000 chars
  // -------------------------------------------------------------------------

  it('DB rejects body longer than 2000 characters (ck_item_body_len, code 23514)', async () => {
    const longBody = 'B'.repeat(2001);
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision', 'Test title', 'Test summary', $2,
                 'ck-body-over-budget', 'integ-test-user')`,
        [SESSION_ID, longBody],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // -------------------------------------------------------------------------
  // Constraint: ux_session_open — second 'open' session for the same key
  //
  // The partial unique index enforces at most one 'open' session per
  // (project_id, repo_id, branch). Inserting a second one must fail (23505).
  // -------------------------------------------------------------------------

  it('DB rejects a second open session for the same (project, repo, branch) (ux_session_open, code 23505)', async () => {
    await expect(
      pool!.query(
        `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
         VALUES ($1, $2, $3, 'main', 'integ-test-user')`,
        [SESSION_ID_DUP, projectId, repoId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  // -------------------------------------------------------------------------
  // Constraint: UNIQUE (session_id, content_hash) — duplicate item
  //
  // First insert succeeds; second insert with the same (session_id,
  // content_hash) must fail (23505).
  // -------------------------------------------------------------------------

  it('DB rejects a duplicate (session_id, content_hash) in staging_item (code 23505)', async () => {
    const hash = 'ck-dedup-unique-hash-test';
    // First insert: must succeed.
    await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity)
       VALUES ($1, 'add', 'decision',
               'Dedup first title', 'Dedup first summary', 'Dedup first body.',
               $2, 'integ-test-user')`,
      [SESSION_ID, hash],
    );
    // Second insert: same session + same hash → UNIQUE violation.
    await expect(
      pool!.query(
        `INSERT INTO staging_item
           (session_id, op, type, title, summary, body, content_hash, author_identity)
         VALUES ($1, 'add', 'decision',
                 'Dedup second title', 'Dedup second summary', 'Dedup second body.',
                 $2, 'integ-test-user')`,
        [SESSION_ID, hash],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
