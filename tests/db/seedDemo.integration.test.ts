/**
 * Demo seed integrity (C8, demo-kit §1). SKIPPED without DATABASE_URL.
 *
 * Applies the migrations and migrations/seed.dev.sql directly (runSeed refuses
 * outside NODE_ENV=development and calls exit), then checks the "Portal de
 * Clientes" data through the real read repositories: two repos, the service-agent
 * credential, 15 active memories of all seven types with history, two past their
 * revalidation deadline, a 4-item review queue (2 uncertain, 2 mandatory) and one
 * quarantine entry per reason code. Applying the seed a second time changes nothing.
 *
 * Assertions are scoped to the seed's fixed ids so rows written by other suites
 * on the shared database never affect them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { repairReducedStagingShape } from './helpers/repairStagingShape.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(__dirname, '..', '..', 'migrations', 'seed.dev.sql');

const PROJECT = '00000000-0000-0000-0000-000000000010';
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** Original C0 memories (40–43) plus the C8 additions (101–111). */
const MEMORY_IDS = [40, 41, 42, 43, ...Array.from({ length: 11 }, (_, i) => 101 + i)].map(uuid);
const EXPIRED_IDS = [104, 108].map(uuid);
const QUEUE_IDS = [301, 302, 303, 304].map(uuid);
const QUARANTINE_IDS = [401, 402, 403, 404, 405].map(uuid);

describeWithDb('demo seed (C8)', () => {
  let pool: pg.Pool;

  async function applySeed(): Promise<void> {
    await pool.query(await fs.readFile(SEED_FILE, 'utf8'));
  }

  /** Every count the seed is responsible for, in one snapshot. */
  async function snapshot(): Promise<Record<string, unknown>> {
    const one = async (sql: string, params: unknown[] = []) =>
      (await pool.query<{ n: number }>(sql, params)).rows[0]!.n;
    return {
      repos: await one(`SELECT count(*)::int AS n FROM repo WHERE project_id = $1`, [PROJECT]),
      credentials: await one(
        `SELECT count(*)::int AS n FROM machine_credential WHERE project_id = $1`,
        [PROJECT],
      ),
      memories: await one(`SELECT count(*)::int AS n FROM memory WHERE id = ANY($1::uuid[])`, [
        MEMORY_IDS,
      ]),
      revisions: await one(
        `SELECT count(*)::int AS n FROM memory_revision WHERE memory_id = ANY($1::uuid[])`,
        [MEMORY_IDS],
      ),
      queue: await one(`SELECT count(*)::int AS n FROM staging_item WHERE id = ANY($1::uuid[])`, [
        QUEUE_IDS,
      ]),
      quarantine: await one(
        `SELECT count(*)::int AS n FROM quarantine WHERE id = ANY($1::uuid[])`,
        [QUARANTINE_IDS],
      ),
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await repairReducedStagingShape(pool);
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    // Start from the pristine seed rows even if another suite touched them.
    await pool.query(`DELETE FROM quarantine WHERE id = ANY($1::uuid[])`, [QUARANTINE_IDS]);
    await pool.query(`DELETE FROM staging_item WHERE id = ANY($1::uuid[])`, [QUEUE_IDS]);
    await pool.query(`DELETE FROM memory WHERE id = ANY($1::uuid[])`, [MEMORY_IDS]);
    await applySeed();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('renames the project and adds the second repo and its service-agent credential', async () => {
    const { rows: p } = await pool.query(`SELECT name, slug FROM project WHERE id = $1`, [PROJECT]);
    expect(p[0]).toEqual({ name: 'Portal de Clientes', slug: 'gmemo' });

    const { rows: repos } = await pool.query(
      `SELECT remote_url FROM repo WHERE project_id = $1 ORDER BY remote_url`,
      [PROJECT],
    );
    expect(repos.map((r) => r.remote_url)).toEqual([
      'https://github.com/crombie-llc/gmemo-demo.git',
      'https://github.com/crombie-llc/portal-clientes-api.git',
    ]);

    const { rows: cred } = await pool.query(
      `SELECT role, token_hash, revoked_at FROM machine_credential
        WHERE project_id = $1 AND principal_name = 'crombie-llc/portal-clientes-api'`,
      [PROJECT],
    );
    expect(cred).toEqual([
      { role: 'service_agent', token_hash: 'oidc:no-shared-secret', revoked_at: null },
    ]);
  });

  it('has 15 active memories covering the seven types, with history', async () => {
    const { rows } = await pool.query<{ type: string; status: string; current_revision: number }>(
      `SELECT type, status, current_revision FROM memory WHERE id = ANY($1::uuid[])`,
      [MEMORY_IDS],
    );
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set([
        'decision',
        'constraint',
        'gotcha',
        'pattern',
        'integration_note',
        'domain_rule',
        'outcome',
      ]),
    );
    expect(rows.filter((r) => r.current_revision >= 2).length).toBeGreaterThanOrEqual(3);

    // Every memory has one revision row per version (1..current_revision).
    const { rows: gaps } = await pool.query(
      `SELECT m.id FROM memory m
        WHERE m.id = ANY($1::uuid[])
          AND (SELECT count(*) FROM memory_revision r WHERE r.memory_id = m.id) <> m.current_revision`,
      [MEMORY_IDS],
    );
    expect(gaps).toEqual([]);
  });

  it('sets revalidate_at on every non-outcome memory, two already expired', async () => {
    const { rows } = await pool.query<{ id: string; type: string; expired: boolean | null }>(
      `SELECT id, type, revalidate_at < now() AS expired FROM memory WHERE id = ANY($1::uuid[])`,
      [MEMORY_IDS],
    );
    for (const r of rows) {
      if (r.type === 'outcome') expect(r.expired).toBeNull();
      else expect(r.expired).not.toBeNull();
    }
    expect(
      rows
        .filter((r) => r.expired)
        .map((r) => r.id)
        .sort(),
    ).toEqual([...EXPIRED_IDS].sort());
  });

  it('queues 4 items in a closed session: 2 uncertain (contradiction, grounding), 2 mandatory', async () => {
    const { PgReviewQueueRepository } = await import('../../src/db/reviewQueueRepository.js');
    const repo = new PgReviewQueueRepository(pool);
    const { rows } = await repo.listQueue(PROJECT, { filter: 'all', type: null, limit: 200 });
    const seeded = rows.filter((r) => QUEUE_IDS.includes(r.id));

    expect(seeded).toHaveLength(4);
    const uncertain = seeded.filter((r) => !r.mandatory_review);
    expect(uncertain.map((r) => r.judge_criterion).sort()).toEqual(['contradiction', 'grounding']);
    expect(
      uncertain.every((r) => r.judge_state === 'uncertain' && r.judge_confidence !== null),
    ).toBe(true);
    expect(seeded.filter((r) => r.mandatory_review)).toHaveLength(2);

    const { rows: sessions } = await pool.query(
      `SELECT DISTINCT ss.status FROM staging_item si JOIN staging_session ss ON ss.id = si.session_id
        WHERE si.id = ANY($1::uuid[])`,
      [QUEUE_IDS],
    );
    expect(sessions.map((s) => s.status)).toEqual(['partially_promoted']);
  });

  it('has one quarantine entry per reason code, the secret one redacted', async () => {
    const { PgQuarantineRepository } = await import('../../src/db/quarantineRepository.js');
    const repo = new PgQuarantineRepository(pool);
    const { rows } = await repo.list(
      PROJECT,
      { isAdmin: true, subject: 'demo-tl' },
      { reason: null, limit: 200 },
    );
    const seeded = rows.filter((r) => QUARANTINE_IDS.includes(r.id));

    expect(seeded.map((r) => r.reasonCode).sort()).toEqual([
      'duplicate_content',
      'embedded_instructions',
      'human_rejected',
      'judge_rejected',
      'secret_detected',
    ]);
    expect(seeded.every((r) => r.criterion !== null && r.daysUntilExpiry !== null)).toBe(true);

    const { rows: secret } = await pool.query(
      `SELECT body FROM quarantine WHERE id = $1 AND reason_code = 'secret_detected'`,
      [uuid(401)],
    );
    expect(secret[0].body).toContain('[REDACTADO]');
  });

  it('is idempotent: a second application changes no count', async () => {
    const before = await snapshot();
    await applySeed();
    expect(await snapshot()).toEqual(before);
  });
});
