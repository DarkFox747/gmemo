/**
 * AuthRepository — the single DB seam for the auth/RBAC path.
 *
 * The interface exposes exactly the four queries the authentication and
 * authorization chain needs:
 *   1. findRepoByRemoteUrl   — tenant resolution (X-Git-Remote → project)
 *   2. findEnabledUserBySubject — Gate 2 user check (sub → enabled app_user)
 *   3. findMembershipRole    — RBAC check (projectId + userId → project_role)
 *   4. insertAccessLog       — audit trail (write after full authorization)
 *
 * C2 (web API) adds two reads: findEnabledUserByEmail (dev login by email)
 * and listProjectsForUser (/me project list, non-archived only).
 *
 * All SQL uses parameterized queries exclusively — no string concatenation.
 * The `PgAuthRepository` is the only production implementation; tests use an
 * in-memory fake (tests/auth/fakes.ts) so security-critical branching is
 * unit-testable without a live database.
 */

import pg from 'pg';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Result of a successful repo lookup; maps to the `repo` table. */
export interface RepoResolution {
  repoId: string;
  projectId: string;
  defaultBranch: string;
}

/** Minimal app_user projection returned by the enabled-user check. */
export interface AppUser {
  userId: string;
  /** Null when the user has no platform-level role. */
  globalRole: string | null;
  email: string;
  displayName: string | null;
}

/** One non-archived project the user belongs to, with their membership role. */
export interface UserProject {
  projectId: string;
  slug: string;
  name: string;
  role: string;
}

/** Payload written to `access_log` on each authorized read. */
export interface AccessLogEntry {
  actorIdentity: string;
  actorKind: 'user' | 'agent' | 'ci' | 'system';
  action: 'read' | 'stage' | 'promote' | 'update' | 'delete' | 'admin';
  projectId: string | null;
  memoryId?: string;
  sessionId?: string;
  /** Server-computed SHA-256 hex digest of the query text; never the raw text. */
  queryHash?: string;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AuthRepository {
  /**
   * Looks up a repo row by its remote URL (the natural key used for tenant
   * resolution). Returns null when the remote is not registered.
   */
  findRepoByRemoteUrl(remoteUrl: string): Promise<RepoResolution | null>;

  /**
   * Resolves a GitHub OIDC `repository` claim (e.g. 'owner/repo') to a
   * RepoResolution by canonicalizing to `https://github.com/<ownerRepo>.git`
   * and looking it up via the repo.remote_url unique key.
   * Returns null when the slug is not registered. (Decision 4)
   */
  findRepoByGithubSlug(ownerRepo: string): Promise<RepoResolution | null>;

  /**
   * Finds an app_user whose `idp_subject` matches `subject` AND whose
   * `disabled_at` is null. Returns null for unknown OR disabled users
   * (indistinguishable — prevents user-existence oracle).
   */
  findEnabledUserBySubject(subject: string): Promise<AppUser | null>;

  /**
   * Finds an enabled app_user by email (DEV login only). The caller passes the
   * email already trimmed and lowercased; matching is case-insensitive.
   * Returns null for unknown, disabled, or ambiguous emails (no oracle).
   */
  findEnabledUserByEmail(email: string): Promise<{ userId: string; idpSubject: string } | null>;

  /**
   * Lists the non-archived projects the user holds a membership in, ordered
   * by project name then id. Returns [] when there are none.
   */
  listProjectsForUser(userId: string): Promise<UserProject[]>;

  /**
   * Fetches the `project_role` for (projectId, userId). Returns null when
   * no membership row exists. Global-role holders still require a membership
   * row for read access (design decision D4).
   */
  findMembershipRole(projectId: string, userId: string): Promise<string | null>;

  /** True when the project exists and is not archived (archived_at IS NULL). */
  isProjectActive(projectId: string): Promise<boolean>;

  /**
   * Inserts one row into `access_log`. Called only after full authorization
   * succeeds — unauthorized attempts are never logged.
   */
  insertAccessLog(entry: AccessLogEntry): Promise<void>;

  /**
   * Finds an active machine_credential row for (projectId, principalName)
   * whose role is in ('service_agent','contributor','project_admin'),
   * revoked_at IS NULL, and expires_at > now(). Returns null when absent
   * (opaque — prevents credential-existence oracle). (Decision 3)
   */
  findActiveMachineCredential(
    projectId: string,
    principalName: string,
  ): Promise<{ role: string } | null>;
}

// ---------------------------------------------------------------------------
// SQL constants (hoisted; parameterized — no string concatenation)
// ---------------------------------------------------------------------------

// Decision 3: machine_credential check for the /promote path.
// Filters to writer-capable roles only; expired and revoked credentials are excluded.
// $1=project_id  $2=principal_name
const FIND_ACTIVE_MACHINE_CREDENTIAL_SQL = `
SELECT role FROM machine_credential
WHERE project_id = $1
  AND principal_name = $2
  AND role IN ('service_agent','contributor','project_admin')
  AND revoked_at IS NULL
  AND expires_at > now()
`.trim();

// Dev login by email. lower(email) keeps the match case-insensitive even for
// mixed-case stored emails; LIMIT 2 lets the caller reject an ambiguous match.
// $1=email (trimmed + lowercased by the caller)
const FIND_ENABLED_USER_BY_EMAIL_SQL = `
SELECT id, idp_subject FROM app_user
WHERE lower(email) = $1 AND disabled_at IS NULL
LIMIT 2
`.trim();

// /me project list — non-archived projects only. $1=user_id
const LIST_PROJECTS_FOR_USER_SQL = `
SELECT p.id, p.slug, p.name, pm.role
FROM project_membership pm JOIN project p ON p.id = pm.project_id
WHERE pm.user_id = $1 AND p.archived_at IS NULL
ORDER BY p.name, p.id
`.trim();

// ---------------------------------------------------------------------------
// pg-backed implementation
// ---------------------------------------------------------------------------

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findRepoByRemoteUrl(remoteUrl: string): Promise<RepoResolution | null> {
    const { rows } = await this.pool.query<{
      id: string;
      project_id: string;
      default_branch: string;
    }>('SELECT id, project_id, default_branch FROM repo WHERE remote_url = $1', [remoteUrl]);

    if (rows.length === 0) return null;
    return {
      repoId: rows[0].id,
      projectId: rows[0].project_id,
      defaultBranch: rows[0].default_branch,
    };
  }

  /**
   * Canonicalizes the OIDC `repository` claim ('owner/repo') to the repo's
   * unique remote_url key (`https://github.com/<ownerRepo>.git`) and delegates
   * to findRepoByRemoteUrl. Pilot simplification: assumes GitHub provider only.
   * The deferred GithubOidcAuthenticator will carry a more robust claim mapping.
   */
  async findRepoByGithubSlug(ownerRepo: string): Promise<RepoResolution | null> {
    // Normalize to lowercase: GitHub slugs are case-insensitive but remote_url
    // is stored lowercase. Runbook instructs operators to register repos lowercase.
    const remoteUrl = `https://github.com/${ownerRepo.toLowerCase()}.git`;
    return this.findRepoByRemoteUrl(remoteUrl);
  }

  async findEnabledUserBySubject(subject: string): Promise<AppUser | null> {
    const { rows } = await this.pool.query<{
      id: string;
      global_role: string | null;
      email: string;
      display_name: string | null;
    }>(
      'SELECT id, global_role, email, display_name FROM app_user WHERE idp_subject = $1 AND disabled_at IS NULL',
      [subject],
    );

    if (rows.length === 0) return null;
    return {
      userId: rows[0].id,
      globalRole: rows[0].global_role,
      email: rows[0].email,
      displayName: rows[0].display_name,
    };
  }

  async findEnabledUserByEmail(
    email: string,
  ): Promise<{ userId: string; idpSubject: string } | null> {
    const { rows } = await this.pool.query<{ id: string; idp_subject: string }>(
      FIND_ENABLED_USER_BY_EMAIL_SQL,
      [email],
    );
    // Zero or ambiguous (two rows differing only by case) → deny.
    if (rows.length !== 1) return null;
    return { userId: rows[0].id, idpSubject: rows[0].idp_subject };
  }

  async listProjectsForUser(userId: string): Promise<UserProject[]> {
    const { rows } = await this.pool.query<{
      id: string;
      slug: string;
      name: string;
      role: string;
    }>(LIST_PROJECTS_FOR_USER_SQL, [userId]);
    return rows.map((r) => ({ projectId: r.id, slug: r.slug, name: r.name, role: r.role }));
  }

  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      'SELECT role FROM project_membership WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );

    if (rows.length === 0) return null;
    return rows[0].role;
  }

  async isProjectActive(projectId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM project WHERE id = $1 AND archived_at IS NULL',
      [projectId],
    );
    return rows.length > 0;
  }

  async insertAccessLog(entry: AccessLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO access_log
         (actor_identity, actor_kind, action, project_id, memory_id, session_id, query_hash, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actorIdentity,
        entry.actorKind,
        entry.action,
        entry.projectId ?? null,
        entry.memoryId ?? null,
        entry.sessionId ?? null,
        entry.queryHash ?? null,
        entry.detail,
      ],
    );
  }

  async findActiveMachineCredential(
    projectId: string,
    principalName: string,
  ): Promise<{ role: string } | null> {
    const { rows } = await this.pool.query<{ role: string }>(
      FIND_ACTIVE_MACHINE_CREDENTIAL_SQL,
      [projectId, principalName],
    );
    if (rows.length === 0) return null;
    return { role: rows[0].role };
  }
}
