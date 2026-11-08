/**
 * Migration integration test — 0008_quarantine_management.sql (C3).
 *
 * SKIPPED when DATABASE_URL is unset. Asserts: new columns + enums, FKs ON
 * DELETE SET NULL, ix_quarantine_list, the classification backfill against the
 * SAME fixture table as tests/quarantine/reason.test.ts (classifier ↔ SQL
 * parity), related/target copied through origin_item_id, expires_at backfill,
 * idempotent re-apply and the ledger row.
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { REASON_FIXTURES } from '../quarantine/reasonFixtures.js';
import { classifyQuarantine } from '../../src/quarantine/reason.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const PROJECT_SLUG = 'quarantine-mgmt-migrate-test';
const REPO_URL = 'https://github.com/test/quarantine-mgmt-migrate-integ';
const SESSION_ID = '01J0QMGMTMIGRATE000000000A';

async function readMigration(): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFile(path.resolve(dir, '../../migrations/0008_quarantine_management.sql'), 'utf8');
}

describeWithDb('migration integration — 0008_quarantine_management.sql', () => {
  let pool: pg.Pool | undefined;
  let projectId: string;
  let repoId: string;
  let memoryId: string;
  /** fixture index → quarantine id */
  const legacyIds: string[] = [];
  let ampId: string;

  async function columnInfo(column: string) {
    const { rows } = await pool!.query(
      `SELECT data_type, udt_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'quarantine' AND column_name = $1`,
      [column],
    );
    return rows[0] as { data_type: string; udt_name: string; is_nullable: string } | undefined;
  }

  async function insertItem(hash: string, criterion: string | null, op = 'add'): Promise<string> {
    const { rows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity,
          judge_criterion, related_memory_id, target_memory_id, target_revision)
       VALUES ($1, $2, 'pattern', 't', 's', 'b', $3, 'mig-user', $4, $5, $6, $7)
       RETURNING id`,
      [
        SESSION_ID,
        op,
        hash,
        criterion,
        memoryId,
        op === 'add' ? null : memoryId,
        op === 'add' ? null : 1,
      ],
    );
    return rows[0].id as string;
  }

  /** A legacy (pre-C3) row: classification and expiry columns left NULL. */
  async function insertLegacy(
    reason: string,
    originItemId: string | null,
    op = 'add',
  ): Promise<string> {
    const { rows } = await pool!.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_session_id, origin_item_id, op, type, title, summary, body,
          content_hash, judge_reason, author_identity, quarantined_at)
       VALUES ($1, $2, $3, $4, $5, 'pattern', 't', 's', 'b', 'h', $6, 'mig-user',
               now() - interval '10 days')
       RETURNING id`,
      [projectId, repoId, SESSION_ID, originItemId, op, reason],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, 'Quarantine Mgmt Migrate Test')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG],
    );
    projectId = (await pool.query(`SELECT id FROM project WHERE slug = $1`, [PROJECT_SLUG])).rows[0]
      .id;
    await pool.query(
      `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2) ON CONFLICT (remote_url) DO NOTHING`,
      [projectId, REPO_URL],
    );
    repoId = (await pool.query(`SELECT id FROM repo WHERE remote_url = $1`, [REPO_URL])).rows[0].id;
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'feat/mig', 'mig-user') ON CONFLICT DO NOTHING`,
      [SESSION_ID, projectId, repoId],
    );
    memoryId = (
      await pool.query(
        `INSERT INTO memory (project_id, type, title, summary, body, provenance, author_identity, content_hash)
         VALUES ($1, 'pattern', 'Mig memory', 'Mig summary', 'Mig body', 'pr_reviewed', 'mig-user', 'qm-mig-mem')
         RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    // One legacy row per fixture. A fixture with a decision criterion keeps a
    // live origin item carrying it; one without has its item swept (null).
    for (const [i, f] of REASON_FIXTURES.entries()) {
      const itemId = f.decisionCriterion
        ? await insertItem(`qm-mig-item-${i}`, f.decisionCriterion)
        : null;
      legacyIds.push(await insertLegacy(f.reason, itemId));
    }
    // Amend row whose origin item still exists → target copied by the backfill.
    const amendItem = await insertItem('qm-mig-amend', 'specificity', 'amend');
    ampId = await insertLegacy('specificity', amendItem, 'amend');

    // Re-run the file: the rows inserted above (criterion NULL) get classified.
    await pool.query(await readMigration());
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM quarantine WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM staging_item WHERE session_id = $1`, [SESSION_ID]);
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.end();
  });

  it('adds the nullable classification, target and restore columns', async () => {
    expect((await columnInfo('criterion'))?.udt_name).toBe('quarantine_criterion');
    expect((await columnInfo('reason_code'))?.udt_name).toBe('quarantine_reason_code');
    for (const c of ['related_memory_id', 'target_memory_id', 'restored_by', 'restored_item_id']) {
      expect((await columnInfo(c))?.data_type).toBe('uuid');
    }
    expect((await columnInfo('target_revision'))?.data_type).toBe('integer');
    expect((await columnInfo('restored_at'))?.data_type).toBe('timestamp with time zone');
    for (const c of [
      'criterion',
      'reason_code',
      'related_memory_id',
      'target_memory_id',
      'target_revision',
      'restored_by',
      'restored_at',
      'restored_item_id',
    ]) {
      expect((await columnInfo(c))?.is_nullable).toBe('YES');
    }
  });

  it('creates both enums with the closed value sets', async () => {
    const labels = async (t: string) =>
      (
        await pool!.query(
          `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          [t],
        )
      ).rows.map((r) => r.enumlabel);
    expect(await labels('quarantine_criterion')).toEqual(['pipeline', 'judge', 'human_review']);
    expect(await labels('quarantine_reason_code')).toEqual([
      'secret_detected',
      'embedded_instructions',
      'duplicate_content',
      'judge_rejected',
      'human_rejected',
      'sanitize_failed',
    ]);
  });

  it('uses ON DELETE SET NULL for related, target and restored_by', async () => {
    const { rows } = await pool!.query(
      `SELECT a.attname AS col, c.confdeltype
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.conrelid = 'quarantine'::regclass
          AND a.attname IN ('related_memory_id','target_memory_id','restored_by')`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.col, r.confdeltype]))).toEqual({
      related_memory_id: 'n',
      target_memory_id: 'n',
      restored_by: 'n',
    });
  });

  it('creates the partial list index', async () => {
    const { rows } = await pool!.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_quarantine_list'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/WHERE \(restored_at IS NULL\)/);
  });

  it('backfills every fixture exactly like classifyQuarantine', async () => {
    for (const [i, f] of REASON_FIXTURES.entries()) {
      const { rows } = await pool!.query(
        `SELECT criterion, reason_code FROM quarantine WHERE id = $1`,
        [legacyIds[i]],
      );
      const expected = classifyQuarantine(f.reason, f.decisionCriterion);
      expect({ name: f.name, ...rows[0] }).toEqual({
        name: f.name,
        criterion: expected.criterion,
        reason_code: expected.reasonCode,
      });
    }
  });

  it('copies related and target through the origin item', async () => {
    const dup = REASON_FIXTURES.findIndex((f) => f.decisionCriterion === 'duplication');
    const { rows } = await pool!.query(`SELECT related_memory_id FROM quarantine WHERE id = $1`, [
      legacyIds[dup],
    ]);
    expect(rows[0].related_memory_id).toBe(memoryId);

    const amend = (
      await pool!.query(`SELECT target_memory_id, target_revision FROM quarantine WHERE id = $1`, [
        ampId,
      ])
    ).rows[0];
    expect(amend).toEqual({ target_memory_id: memoryId, target_revision: 1 });
  });

  it('backfills expires_at = quarantined_at + 60 days', async () => {
    const { rows } = await pool!.query(
      `SELECT bool_and(expires_at = quarantined_at + interval '60 days') AS ok
         FROM quarantine WHERE project_id = $1`,
      [projectId],
    );
    expect(rows[0].ok).toBe(true);
  });

  it('re-applying the file leaves classified rows unchanged', async () => {
    const snapshot = async () =>
      (
        await pool!.query(
          `SELECT id, criterion, reason_code, related_memory_id, target_memory_id, expires_at
             FROM quarantine WHERE project_id = $1 ORDER BY id`,
          [projectId],
        )
      ).rows;
    const before = await snapshot();
    await expect(pool!.query(await readMigration())).resolves.toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it('records 0008_quarantine_management in schema_migrations', async () => {
    const { rows } = await pool!.query(
      `SELECT version FROM schema_migrations WHERE version = '0008_quarantine_management'`,
    );
    expect(rows).toHaveLength(1);
  });
});
