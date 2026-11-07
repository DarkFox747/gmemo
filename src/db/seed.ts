/**
 * DEV-ONLY seed runner. Refuses under NODE_ENV=production.
 * Run via `pnpm seed:dev` (tsx src/db/seed.ts) or `node dist/db/seed.js` (container).
 *
 * Applies migrations/seed.dev.sql which contains idempotent sample data used
 * by the local dev harness (docker compose). This file is intentionally NOT
 * picked up by the migration runner (src/db/migrate.ts), which matches only
 * numbered files (^\d{4}_.*\.sql$).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, closePool } from './pool.js';

// Resolve migrations/ relative to this file so the path is correct whether
// the script runs as src/db/seed.ts (tsx) or dist/db/seed.js (node).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(__dirname, '..', '..', 'migrations', 'seed.dev.sql');

export async function runSeed(connectionString: string): Promise<void> {
  if (process.env.NODE_ENV !== 'development') {
    console.error(
      `[seed] Refusing to seed: NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}. ` +
        'Dev seed runs only when NODE_ENV=development.',
    );
    process.exit(1);
  }

  const pool = createPool(connectionString, false); // local dev: no TLS enforcement
  const client = await pool.connect();
  try {
    const sql = await fs.readFile(SEED_FILE, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[seed] Dev seed applied (idempotent).');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[seed] Failed:', err);
      throw err;
    }
  } finally {
    client.release();
    await closePool(pool);
  }
}

// Guard CLI auto-run behind a main-module check so importing this module
// has no side effect. `pnpm seed:dev` still works via tsx src/db/seed.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed(process.env.DATABASE_URL ?? '').catch(() => process.exit(1));
}
