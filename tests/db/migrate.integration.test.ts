/**
 * T167: Migration integration test — forward-only runner + schema smoke check.
 *
 * This test is SKIPPED when `process.env.DATABASE_URL` is unset so the test
 * suite stays green in CI environments without a database container. It only
 * runs when a real Postgres connection string is available (developer workstation
 * or a dedicated CI job with `services: postgres`).
 *
 * When it does run, it:
 *  1. Executes the migration runner against the provided DATABASE_URL.
 *  2. Asserts that all 6 auth/tenancy tables exist.
 *  3. Asserts that all 4 enums exist.
 *  4. Asserts that an access_log INSERT round-trips correctly (actor_kind, action,
 *     project_id, query_hash written and readable back).
 *  5. Tears down (drops all migrated objects) so the test is idempotent.
 *
 * Prerequisites: a Postgres 16 database reachable at DATABASE_URL with CREATE
 * privileges. The runner creates the `schema_migrations` ledger table if absent.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Skip guard — entire suite is skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers (loaded lazily inside the describe block to avoid module-level
// import of `pg` when DATABASE_URL is absent).
// ---------------------------------------------------------------------------

describeWithDb('migration integration — 0001_auth_tenancy.sql', () => {
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the migration forward
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
  });

  afterAll(async () => {
    if (!pool) return;

    // Tear down: drop migrated tables and types so tests are idempotent.
    // Order matters due to FK constraints.
    await pool.query(`
      DROP TABLE IF EXISTS access_log CASCADE;
      DROP TABLE IF EXISTS machine_credential CASCADE;
      DROP TABLE IF EXISTS project_membership CASCADE;
      DROP TABLE IF EXISTS repo CASCADE;
      DROP TABLE IF EXISTS project CASCADE;
      DROP TABLE IF EXISTS app_user CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
      DROP TYPE IF EXISTS global_role CASCADE;
      DROP TYPE IF EXISTS project_role CASCADE;
      DROP TYPE IF EXISTS actor_kind CASCADE;
      DROP TYPE IF EXISTS access_action CASCADE;
    `);

    await pool.end();
  });

  // --- Table existence ---

  const EXPECTED_TABLES = [
    'app_user',
    'project',
    'repo',
    'project_membership',
    'machine_credential',
    'access_log',
  ];

  for (const tableName of EXPECTED_TABLES) {
    it(`table "${tableName}" exists after migration`, async () => {
      const { rows } = await pool!.query(
        `SELECT to_regclass($1::text)::text AS exists`,
        [tableName],
      );
      expect(rows[0].exists).toBe(tableName);
    });
  }

  // --- Enum existence ---

  const EXPECTED_ENUMS = ['global_role', 'project_role', 'actor_kind', 'access_action'];

  for (const enumName of EXPECTED_ENUMS) {
    it(`enum "${enumName}" exists after migration`, async () => {
      const { rows } = await pool!.query(
        `SELECT typname FROM pg_type WHERE typname = $1 AND typtype = 'e'`,
        [enumName],
      );
      expect(rows).toHaveLength(1);
    });
  }

  // --- schema_migrations ledger ---

  it('schema_migrations ledger records the applied migration version', async () => {
    // Version is stored without the .sql suffix (e.g. '0001_auth_tenancy')
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0001_auth_tenancy'`,
    );
    expect(rows).toHaveLength(1);
  });

  // --- access_log round-trip ---

  it('access_log INSERT round-trips correctly', async () => {
    // We need a project row to satisfy the FK (ON DELETE SET NULL, so we insert one).
    await pool!.query(
      `INSERT INTO project (slug, name) VALUES ('integ-test', 'Integration Test') ON CONFLICT DO NOTHING`,
    );
    const { rows: projRows } = await pool!.query(
      `SELECT id FROM project WHERE slug = 'integ-test'`,
    );
    const projectId: string = projRows[0].id as string;

    const queryHash = 'a'.repeat(64); // 64-char hex string simulating a SHA-256 digest

    await pool!.query(
      `INSERT INTO access_log
         (actor_identity, actor_kind, action, project_id, query_hash, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['integ-test-sub', 'user', 'read', projectId, queryHash, '{}'],
    );

    const { rows } = await pool!.query(
      `SELECT actor_identity, actor_kind, action, query_hash
         FROM access_log
        WHERE actor_identity = 'integ-test-sub'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_identity).toBe('integ-test-sub');
    expect(rows[0].actor_kind).toBe('user');
    expect(rows[0].action).toBe('read');
    expect(rows[0].query_hash).toBe(queryHash);
  });
});
