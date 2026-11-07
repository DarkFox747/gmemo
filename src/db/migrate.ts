/**
 * Forward-only migration runner.
 *
 * Algorithm:
 *  1. Create a `schema_migrations(version, applied_at)` ledger table if absent.
 *  2. Read all *.sql files under <project-root>/migrations/, sorted lexically.
 *  3. For each file whose name is not already in the ledger, execute the SQL
 *     inside a single transaction, then record the bare version (without the
 *     .sql suffix). Rolls back on any error and re-throws.
 *  4. Files already in the ledger are skipped — the runner is fully idempotent.
 *
 * Run via `pnpm migrate` (tsx src/db/migrate.ts).
 * Accepts a connection string as its argument — does NOT call loadConfig()
 * and does NOT require any COGNITO_* environment variables.
 * No drops, no rollbacks of previously applied migrations.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, closePool } from './pool.js';

// Resolve migrations/ relative to this file so the path is correct whether
// the script runs as src/db/migrate.ts (tsx) or dist/db/migrate.js (node).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = createPool(connectionString, process.env.NODE_ENV === 'production');
  const client = await pool.connect();

  try {
    // Create the ledger table unconditionally — it tracks which files have been
    // applied so subsequent runs can skip them.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Collect already-applied versions (stored without the .sql suffix).
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(rows.map((r: { version: string }) => r.version));

    // Read and sort migration files lexically (0001_ < 0002_ < …).
    let files: string[];
    try {
      // Numbered migrations only (0001_*.sql, 0002_*.sql, …).
      // This explicitly excludes seed.dev.sql and any other non-migration .sql
      // files so they can never be applied by the prod migrate runner.
      files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((f) => /^\d{4}_.*\.sql$/.test(f))
        .sort();
    } catch {
      console.error(`[migrate] Cannot read migrations directory: ${MIGRATIONS_DIR}`);
      process.exit(1);
    }

    let appliedCount = 0;

    for (const file of files) {
      // Strip the .sql suffix before ledger operations so the stored version is
      // a bare identifier (e.g. '0001_auth_tenancy', not '0001_auth_tenancy.sql').
      const version = file.replace(/\.sql$/, '');

      if (applied.has(version)) {
        console.log(`[migrate] Skipping (already applied): ${file}`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = await fs.readFile(filePath, 'utf8');

      // Each migration runs in its own transaction so a failure leaves the DB
      // in the pre-migration state and the ledger unchanged.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied: ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] Failed on ${file}:`, err);
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.log('[migrate] Nothing to apply — schema is up to date.');
    } else {
      console.log(`[migrate] Done. Applied ${appliedCount} migration(s).`);
    }
  } finally {
    client.release();
    await closePool(pool);
  }
}

// Guard CLI auto-run behind a main-module check so importing this module
// has no side effect. `pnpm migrate` still works via tsx src/db/migrate.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations(process.env.DATABASE_URL ?? '').catch(() => process.exit(1));
}
