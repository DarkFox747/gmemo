/**
 * Read-path status exclusion against real SQL (C4, memory-read delta; HU-12.1).
 *
 * SKIPPED when DATABASE_URL is unset. For each non-active status, one active and
 * one hidden row with matching content: PgMemoryRepository.recall (lexical),
 * recallSemantic (non-null embeddings), getMemoryByHandle (+ relations),
 * getContextRecords (phase 1 + 2) and PgPromotionRepository.findJudgeContext
 * return only the active row.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PgMemoryRepository } from '../../src/db/memoryRepository.js';
import { PgPromotionRepository } from '../../src/db/promotionRepository.js';
import { toVectorParam } from '../../src/db/vector.js';
import type { TenantContext } from '../../src/mcp/context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'status-exclusion-integ';
const REPO_URL = 'https://github.com/test/status-exclusion-integ';
const UNIT_VEC: number[] = [1, ...new Array(1023).fill(0)];
const NON_ACTIVE = ['superseded', 'deprecated', 'pending_revalidation'] as const;

describeWithDb('read-path status exclusion (real SQL)', () => {
  let pool: pg.Pool;
  let memoryRepo: PgMemoryRepository;
  let promotionRepo: PgPromotionRepository;
  let tenant: TenantContext;
  let seq = 0;

  async function seed(type: string, status: string, title: string): Promise<string> {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, embedding)
       VALUES ($1, $2, $3, $4, 'Zephyrine lifecycle exclusion summary',
               'Zephyrine lifecycle exclusion body', $5, 'pr_reviewed', 'seed-user', $6,
               $7::vector)
       RETURNING id`,
      [
        tenant.projectId,
        tenant.repoId,
        type,
        title,
        status,
        `status-excl-${seq}-${Date.now()}`,
        toVectorParam(UNIT_VEC),
      ],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    memoryRepo = new PgMemoryRepository(pool);
    promotionRepo = new PgPromotionRepository(pool, {
      quarantineRetentionDays: 60,
      revalidationDays: 60,
    });

    const { rows: p } = await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [SLUG],
    );
    const { rows: r } = await pool.query(
      `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
       ON CONFLICT (remote_url) DO UPDATE SET remote_url = EXCLUDED.remote_url RETURNING id`,
      [p[0].id, REPO_URL],
    );
    tenant = { projectId: p[0].id as string, repoId: r[0].id as string, branch: 'main' };
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM memory WHERE project_id = $1`, [tenant.projectId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    await pool.end();
  });

  describe.each(NON_ACTIVE)('%s rows are hidden', (status) => {
    it('recallLexicalCandidates returns only the active row', async () => {
      await seed('decision', 'active', 'Active zephyrine row');
      await seed('decision', status, 'Hidden zephyrine row');
      const rows = await memoryRepo.recallLexicalCandidates(
        tenant,
        { query: 'zephyrine lifecycle', scope: 'project' },
        50,
      );
      expect(rows.map((r) => r.title)).toEqual(['Active zephyrine row']);
    });

    it('recallSemantic returns only the active row', async () => {
      await seed('decision', 'active', 'Active zephyrine row');
      await seed('decision', status, 'Hidden zephyrine row');
      const rows = await memoryRepo.recallSemantic(tenant, UNIT_VEC, { scope: 'project' }, [], 8);
      expect(rows.map((r) => r.title)).toEqual(['Active zephyrine row']);
    });

    it('getMemoryByHandle: hidden → null (same as unknown); relations skip the hidden side', async () => {
      const active = await seed('decision', 'active', 'Active zephyrine row');
      const hidden = await seed('decision', status, 'Hidden zephyrine row');
      await pool.query(
        `INSERT INTO memory_relation (from_memory, to_memory, relation_type, source)
         VALUES ($1, $2, 'supersedes', 'judge')`,
        [active, hidden],
      );
      expect(await memoryRepo.getMemoryByHandle(tenant, hidden)).toBeNull();
      expect(
        await memoryRepo.getMemoryByHandle(tenant, '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11'),
      ).toBeNull();
      const detail = await memoryRepo.getMemoryByHandle(tenant, active);
      expect(detail?.relations).toEqual([]);
    });

    it('getContextRecords excludes it from phase 1 and phase 2', async () => {
      await seed('constraint', 'active', 'Active constraint');
      await seed('constraint', status, 'Hidden constraint');
      await seed('decision', 'active', 'Active decision');
      await seed('decision', status, 'Hidden decision');
      const ctx = await memoryRepo.getContextRecords(tenant, 50);
      expect(ctx.phase1.map((r) => r.title)).toEqual(['Active constraint']);
      expect(ctx.phase2.map((r) => r.title)).toEqual(['Active decision']);
    });

    it('findJudgeContext excludes it', async () => {
      await seed('decision', 'active', 'Active zephyrine row');
      await seed('decision', status, 'Hidden zephyrine row');
      const items = await promotionRepo.findJudgeContext(
        tenant.projectId,
        { title: 'zephyrine row', summary: 'zephyrine lifecycle exclusion' },
        null,
      );
      expect(items.map((i) => i.title)).toEqual(['Active zephyrine row']);
    });
  });
});
