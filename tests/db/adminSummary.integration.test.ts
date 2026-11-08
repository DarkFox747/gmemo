/**
 * PgAdminSummaryRepository integration tests (C7). SKIPPED without DATABASE_URL.
 *
 * Project, repos (with default branch), members with role and disabled flag,
 * credential status active/expired/revoked; other projects are excluded; an
 * archived project is null; token_hash is never returned.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgAdminSummaryRepository as Repo } from '../../src/db/adminSummaryRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUGS = ['adminsum-integ-p', 'adminsum-integ-q', 'adminsum-integ-archived'];
const HASH = 'adminsum-secret-token-hash';

describeWithDb('PgAdminSummaryRepository integration', () => {
  let pool: pg.Pool;
  let repo: Repo;
  let P: string;
  let Q: string;
  let archived: string;

  async function project(slug: string, archivedAt: string | null = null): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO project (slug, name, archived_at) VALUES ($1, $1, $2::timestamptz) RETURNING id`,
      [slug, archivedAt],
    );
    return rows[0].id as string;
  }

  async function user(subject: string, name: string | null, disabled = false): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name, disabled_at)
       VALUES ($1, $1 || '@adminsum.test', $2, CASE WHEN $3::boolean THEN now() END)
       ON CONFLICT (idp_subject) DO UPDATE SET display_name = EXCLUDED.display_name,
         disabled_at = EXCLUDED.disabled_at
       RETURNING id`,
      [subject, name, disabled],
    );
    return rows[0].id as string;
  }

  async function credential(
    projectId: string,
    name: string,
    expires: string,
    revoked: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO machine_credential (project_id, principal_name, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, $3, now() + $4::interval, CASE WHEN $5::boolean THEN now() END)`,
      [projectId, name, HASH, expires, revoked],
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgAdminSummaryRepository } = await import('../../src/db/adminSummaryRepository.js');
    repo = new PgAdminSummaryRepository(pool);
    await pool.query(`DELETE FROM project WHERE slug = ANY($1)`, [SLUGS]);
    P = await project(SLUGS[0]!);
    Q = await project(SLUGS[1]!);
    archived = await project(SLUGS[2]!, '2026-01-01T00:00:00Z');

    await pool.query(
      `INSERT INTO repo (project_id, remote_url, slug, provider, default_branch, created_at)
       VALUES ($1, 'https://github.com/adminsum/p1', 'adminsum/p1', 'github', 'develop', '2026-01-01T00:00:00Z'),
              ($1, 'https://github.com/adminsum/p2', 'adminsum/p2', NULL, 'main', '2026-02-01T00:00:00Z'),
              ($2, 'https://github.com/adminsum/q1', 'adminsum/q1', 'github', 'main', '2026-01-01T00:00:00Z')`,
      [P, Q],
    );
    const tl = await user('adminsum-tl', 'Ana Líder');
    const dev = await user('adminsum-dev', 'Bruno Dev');
    const gone = await user('adminsum-gone', null, true);
    const qUser = await user('adminsum-q', 'Q Only');
    await pool.query(
      `INSERT INTO project_membership (project_id, user_id, role)
       VALUES ($1, $2, 'project_admin'), ($1, $3, 'contributor'), ($1, $4, 'viewer'), ($5, $6, 'project_admin')`,
      [P, tl, dev, gone, Q, qUser],
    );
    await credential(P, 'ci-active', '30 days', false);
    await credential(P, 'ci-expired', '-1 day', false);
    await credential(P, 'ci-revoked', '30 days', true);
    await credential(Q, 'ci-q', '30 days', false);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project WHERE slug = ANY($1)`, [SLUGS]);
    await pool.query(`DELETE FROM app_user WHERE idp_subject LIKE 'adminsum-%'`);
    await pool.end();
  });

  it('returns the project, its repos in creation order, members and credentials', async () => {
    const s = await repo.getAdminSummary(P);
    expect(s).not.toBeNull();
    expect(s!.project).toMatchObject({ id: P, slug: SLUGS[0], name: SLUGS[0] });
    expect(s!.repos.map((r) => [r.slug, r.defaultBranch, r.provider])).toEqual([
      ['adminsum/p1', 'develop', 'github'],
      ['adminsum/p2', 'main', null],
    ]);
    expect(s!.members.map((m) => [m.email, m.role, m.disabled])).toEqual([
      ['adminsum-tl@adminsum.test', 'project_admin', false],
      ['adminsum-dev@adminsum.test', 'contributor', false],
      ['adminsum-gone@adminsum.test', 'viewer', true],
    ]);
    expect(s!.credentials.map((c) => [c.principalName, c.role, c.status])).toEqual([
      ['ci-active', 'service_agent', 'active'],
      ['ci-expired', 'service_agent', 'expired'],
      ['ci-revoked', 'service_agent', 'revoked'],
    ]);
    expect(s!.credentials[2]!.revokedAt).not.toBeNull();
  });

  it('never returns another project rows nor the token hash', async () => {
    const s = await repo.getAdminSummary(P);
    const text = JSON.stringify(s);
    expect(text).not.toContain('adminsum/q1');
    expect(text).not.toContain('ci-q');
    expect(text).not.toContain('Q Only');
    expect(text).not.toContain(HASH);
    expect(text).not.toMatch(/token/i);
    for (const c of s!.credentials) expect(c).not.toHaveProperty('token_hash');
  });

  it('archived or unknown project → null', async () => {
    expect(await repo.getAdminSummary(archived)).toBeNull();
    expect(await repo.getAdminSummary('6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11')).toBeNull();
  });
});
