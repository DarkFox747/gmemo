/**
 * Vitest global setup: gives DB-backed suites a clean schema on every run.
 *
 * Several migration suites tear down only their own objects, so leftovers from
 * a previous run (e.g. staging_item without later-migration columns) break the
 * next one. Wiping the public schema once up front makes the run deterministic.
 * Runs only when DATABASE_URL is set, and only against a local database.
 */
import pg from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  const parsed = new URL(url);
  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to reset the schema of a non-local test database (host: ${host})`);
  }
  // A developer machine may also run its own PostgreSQL on localhost; only the
  // compose database (named "gmemo") is ever wiped.
  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'gmemo') {
    throw new Error(`Refusing to reset the schema of database "${database}" (only the compose "gmemo" db is reset)`);
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
}
