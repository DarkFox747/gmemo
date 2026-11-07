import pg from 'pg';

/**
 * Creates a new `pg.Pool` bound to the given connection string.
 *
 * TLS enforcement: callers pass `enforceSSL=true` in production to mandate TLS
 * with certificate verification and prevent MITM attacks. Callers (not this
 * module) decide what "production" means — no `process.env` reads here.
 *
 * Call this ONCE at boot and inject the returned pool everywhere it is needed.
 * Never call at module import time — that would create a connection on any
 * import, breaking tests and confusing startup order.
 */
export function createPool(connectionString: string, enforceSSL: boolean): pg.Pool {
  const ssl = enforceSSL ? { rejectUnauthorized: true } : undefined;
  return new pg.Pool({ connectionString, ssl });
}

/**
 * Drains and closes all idle connections in the pool.
 * Call during graceful shutdown after all in-flight requests have finished.
 */
export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
