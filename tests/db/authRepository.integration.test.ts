/**
 * PgAuthRepository integration — C2 reads (findEnabledUserByEmail, listProjectsForUser)
 * and the dev seed section 9 (three demo users on project …0010).
 *
 * SKIPPED when DATABASE_URL is unset. Applies migrations, then the dev seed SQL
 * directly (runSeed refuses outside NODE_ENV=development and calls exit).
 * Rows created by this suite use their own slugs/subjects and are removed in afterAll.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { repairReducedStagingShape } from './helpers/repairStagingShape.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AuthRepository } from '../../src/db/authRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.resolve(__dirname, '..', '..', 'migrations', 'seed.dev.sql');

const SEED_PROJECT = '00000000-0000-0000-0000-000000000010';
const DEMO = {
  tl: {
    id: '00000000-0000-0000-0000-000000000002',
    subject: 'demo-tl',
    email: 'tl@demo.local',
    role: 'project_admin',
  },
  dev: {
    id: '00000000-0000-0000-0000-000000000003',
    subject: 'demo-dev',
    email: 'dev@demo.local',
    role: 'contributor',
  },
  viewer: {
    id: '00000000-0000-0000-0000-000000000004',
    subject: 'demo-viewer',
    email: 'viewer@demo.local',
    role: 'viewer',
  },
};

describeWithDb('PgAuthRepository integration (C2 reads + seed)', () => {
  let pool: pg.Pool;
  let repo: AuthRepository;
  let disabledUserId: string;
  let activeProjectId: string;
  let archivedProjectId: string;

  async function applySeed(): Promise<void> {
    await pool.query(await fs.readFile(SEED_FILE, 'utf8'));
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    await repairReducedStagingShape(pool);

    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgAuthRepository } = await import('../../src/db/authRepository.js');
    repo = new PgAuthRepository(pool);

    await applySeed();

    const { rows: dis } = await pool.query<{ id: string }>(
      `INSERT INTO app_user (idp_subject, email, display_name, disabled_at)
       VALUES ('authrepo-integ-disabled', 'disabled@authrepo.test', NULL, now())
       ON CONFLICT (idp_subject) DO UPDATE SET disabled_at = now()
       RETURNING id`,
    );
    disabledUserId = dis[0].id;

    const { rows: active } = await pool.query<{ id: string }>(
      `INSERT INTO project (slug, name) VALUES ('authrepo-integ-active', 'AAA Active')
       ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`,
    );
    activeProjectId = active[0].id;
    const { rows: archived } = await pool.query<{ id: string }>(
      `INSERT INTO project (slug, name, archived_at) VALUES ('authrepo-integ-archived', 'AAA Archived', now())
       ON CONFLICT (slug) DO UPDATE SET archived_at = now() RETURNING id`,
    );
    archivedProjectId = archived[0].id;

    await pool.query(
      `INSERT INTO project_membership (project_id, user_id, role) VALUES ($1, $3, 'viewer'), ($2, $3, 'contributor')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [activeProjectId, archivedProjectId, DEMO.viewer.id],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      `DELETE FROM project WHERE slug IN ('authrepo-integ-active', 'authrepo-integ-archived')`,
    );
    await pool.query(`DELETE FROM app_user WHERE idp_subject = 'authrepo-integ-disabled'`);
    await pool.end();
  });

  it('findEnabledUserByEmail resolves the three seeded demo users', async () => {
    for (const u of Object.values(DEMO)) {
      await expect(repo.findEnabledUserByEmail(u.email)).resolves.toEqual({
        userId: u.id,
        idpSubject: u.subject,
      });
    }
  });

  it('findEnabledUserByEmail excludes disabled and unknown users', async () => {
    expect(disabledUserId).toBeTruthy();
    await expect(repo.findEnabledUserByEmail('disabled@authrepo.test')).resolves.toBeNull();
    await expect(repo.findEnabledUserByEmail('nobody@demo.local')).resolves.toBeNull();
  });

  it('findEnabledUserBySubject returns email and displayName', async () => {
    await expect(repo.findEnabledUserBySubject('demo-tl')).resolves.toEqual({
      userId: DEMO.tl.id,
      globalRole: null,
      email: 'tl@demo.local',
      displayName: 'Tech Lead (demo)',
    });
  });

  it('seeded memberships on project …0010 are project_admin / contributor / viewer', async () => {
    for (const u of Object.values(DEMO)) {
      await expect(repo.findMembershipRole(SEED_PROJECT, u.id)).resolves.toBe(u.role);
    }
  });

  it('listProjectsForUser excludes archived projects and orders by name', async () => {
    const projects = await repo.listProjectsForUser(DEMO.viewer.id);
    expect(projects.map((p) => p.projectId)).not.toContain(archivedProjectId);
    expect(projects).toEqual([
      {
        projectId: activeProjectId,
        slug: 'authrepo-integ-active',
        name: 'AAA Active',
        role: 'viewer',
      },
      { projectId: SEED_PROJECT, slug: 'gmemo', name: 'Portal de Clientes', role: 'viewer' },
    ]);
  });

  it('isProjectActive is true for active projects only (archived/unknown -> false)', async () => {
    await expect(repo.isProjectActive(SEED_PROJECT)).resolves.toBe(true);
    await expect(repo.isProjectActive(activeProjectId)).resolves.toBe(true);
    await expect(repo.isProjectActive(archivedProjectId)).resolves.toBe(false);
    await expect(
      repo.isProjectActive('6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11'),
    ).resolves.toBe(false);
  });

  it('re-running the seed is idempotent', async () => {
    await applySeed();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app_user WHERE idp_subject IN ('demo-tl', 'demo-dev', 'demo-viewer')`,
    );
    expect(rows[0].n).toBe(3);
    const { rows: m } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM project_membership WHERE project_id = $1 AND user_id = ANY($2::uuid[])`,
      [SEED_PROJECT, Object.values(DEMO).map((u) => u.id)],
    );
    expect(m[0].n).toBe(3);
  });
});
