/**
 * AdminSummaryRepository — read-only project summary for the web
 * Administración screen (C7): project, repos, members with role and service
 * credentials with status.
 *
 * Every statement is scoped by project_id and uses explicit column lists;
 * machine_credential.token_hash is NEVER selected. An archived or missing
 * project returns null (the route maps it to the uniform 404).
 */

import type pg from 'pg';
import type { ProjectRole } from '../mcp/context.js';
import type { AdminSummaryDto } from '../http/api/types.js';

export interface AdminSummaryRepository {
  getAdminSummary(projectId: string): Promise<AdminSummaryDto | null>;
}

const PROJECT_SQL = `
  SELECT id, slug, name, created_at
  FROM project
  WHERE id = $1 AND archived_at IS NULL`;

const REPOS_SQL = `
  SELECT id, remote_url, slug, provider, default_branch, created_at
  FROM repo
  WHERE project_id = $1
  ORDER BY created_at, id`;

const MEMBERS_SQL = `
  SELECT u.id, u.email, u.display_name, pm.role, pm.granted_at,
         (u.disabled_at IS NOT NULL) AS disabled
  FROM project_membership pm
  JOIN app_user u ON u.id = pm.user_id
  WHERE pm.project_id = $1
  ORDER BY pm.role, lower(COALESCE(u.display_name, u.email)), u.id`;

// Explicit column list: token_hash is never read.
const CREDENTIALS_SQL = `
  SELECT id, principal_name, role, created_at, expires_at, revoked_at,
         CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN expires_at <= now() THEN 'expired'
              ELSE 'active' END AS status
  FROM machine_credential
  WHERE project_id = $1
  ORDER BY principal_name, id`;

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
}
interface RepoRow {
  id: string;
  remote_url: string;
  slug: string | null;
  provider: string | null;
  default_branch: string;
  created_at: Date;
}
interface MemberRow {
  id: string;
  email: string;
  display_name: string | null;
  role: ProjectRole;
  granted_at: Date;
  disabled: boolean;
}
interface CredentialRow {
  id: string;
  principal_name: string;
  role: ProjectRole;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  status: 'active' | 'expired' | 'revoked';
}

export class PgAdminSummaryRepository implements AdminSummaryRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async getAdminSummary(projectId: string): Promise<AdminSummaryDto | null> {
    const project = await this.pool.query<ProjectRow>(PROJECT_SQL, [projectId]);
    const p = project.rows[0];
    if (!p) return null;

    const [repos, members, credentials] = await Promise.all([
      this.pool.query<RepoRow>(REPOS_SQL, [projectId]),
      this.pool.query<MemberRow>(MEMBERS_SQL, [projectId]),
      this.pool.query<CredentialRow>(CREDENTIALS_SQL, [projectId]),
    ]);

    return {
      project: { id: p.id, slug: p.slug, name: p.name, createdAt: p.created_at.toISOString() },
      repos: repos.rows.map((r) => ({
        id: r.id,
        remoteUrl: r.remote_url,
        slug: r.slug,
        provider: r.provider,
        defaultBranch: r.default_branch,
        createdAt: r.created_at.toISOString(),
      })),
      members: members.rows.map((m) => ({
        userId: m.id,
        email: m.email,
        displayName: m.display_name,
        role: m.role,
        grantedAt: m.granted_at.toISOString(),
        disabled: m.disabled,
      })),
      credentials: credentials.rows.map((c) => ({
        id: c.id,
        principalName: c.principal_name,
        role: c.role,
        createdAt: c.created_at.toISOString(),
        expiresAt: c.expires_at.toISOString(),
        revokedAt: c.revoked_at ? c.revoked_at.toISOString() : null,
        status: c.status,
      })),
    };
  }
}
