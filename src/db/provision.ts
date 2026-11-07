/**
 * Gate-2 pilot onboarding provisioner.
 *
 * Creates the tenancy rows needed for an authenticated Cognito user to use the
 * MCP tools against a specific project and repo:
 *
 *   project → repo → app_user(s) → project_membership(s)
 *
 * Idempotent: every INSERT uses ON CONFLICT … DO NOTHING against existing unique
 * constraints, so the script is safe to run multiple times without duplicating data.
 * All four writes happen inside a single transaction; any failure rolls the whole
 * thing back.
 *
 * Run as a one-off ECS Fargate task, same pattern as dist/db/migrate.js:
 *   command override: ["node", "dist/db/provision.js"]
 *   env: DATABASE_URL (from Secrets Manager), NODE_EXTRA_CA_CERTS, PROVISION_JSON
 *
 * Do NOT import from seed.ts — dev-only; forbidden on pilot.
 */

import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPool, closePool } from './pool.js';

// ---------------------------------------------------------------------------
// Input schema — validated from the PROVISION_JSON environment variable.
// ---------------------------------------------------------------------------

const ProvisionUserSchema = z.object({
  /** Cognito sub (idp_subject) for the user. */
  idp_subject: z.string().min(1),
  email: z.string().email(),
  /** Must be a valid project_role enum value (matches the DB CHECK). */
  role: z.enum(['project_admin', 'contributor', 'viewer', 'service_agent']),
});

const ProvisionSchema = z.object({
  /** Full HTTPS git remote URL, e.g. "https://github.com/<GITHUB_ORG>/<REPO>.git".
   *  Stored lowercase — normalized before any DB operation. */
  remote_url: z.string().url(),
  project: z.object({
    /** Unique slug used as the natural key for the project row. */
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
  /** At least one user must be provisioned. */
  users: z.array(ProvisionUserSchema).min(1),
});

export type ProvisionInput = z.infer<typeof ProvisionSchema>;

// ---------------------------------------------------------------------------
// Core provisioner — exported so it is unit-testable without spawning a process.
// ---------------------------------------------------------------------------

export async function runProvision(
  connectionString: string,
  input: ProvisionInput,
): Promise<void> {
  // Mirror migrate.ts: enforce SSL in production so NODE_EXTRA_CA_CERTS trust is
  // required and rejectUnauthorized prevents MITM against the pilot RDS.
  const enforceSSL = process.env.NODE_ENV === 'production';
  const pool = createPool(connectionString, enforceSSL);
  const client = await pool.connect();

  // Normalize remote_url to lowercase — tenant resolution and findRepoByGithubSlug
  // both canonicalize to lowercase; the stored value must match.
  const remoteUrl = input.remote_url.toLowerCase();
  const { slug, name } = input.project;

  try {
    await client.query('BEGIN');

    // -----------------------------------------------------------------------
    // 1. project — unique key: slug
    // -----------------------------------------------------------------------

    // RETURNING id on insert; SELECT id on conflict-skip (already existed).
    const insertProjectResult = await client.query<{ id: string }>(
      `INSERT INTO project (slug, name)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [slug, name],
    );

    let projectId: string;
    if (insertProjectResult.rows.length > 0) {
      projectId = insertProjectResult.rows[0].id;
      console.log(`[provision] project created: slug=${slug} id=${projectId}`);
    } else {
      const sel = await client.query<{ id: string }>(
        'SELECT id FROM project WHERE slug = $1',
        [slug],
      );
      projectId = sel.rows[0].id;
      console.log(`[provision] project already existed: slug=${slug} id=${projectId}`);
    }

    // -----------------------------------------------------------------------
    // 2. repo — unique key: remote_url
    // -----------------------------------------------------------------------

    const insertRepoResult = await client.query<{ id: string }>(
      `INSERT INTO repo (project_id, remote_url, provider, default_branch)
       VALUES ($1, $2, 'github', 'main')
       ON CONFLICT (remote_url) DO NOTHING
       RETURNING id`,
      [projectId, remoteUrl],
    );

    if (insertRepoResult.rows.length > 0) {
      console.log(
        `[provision] repo created: remote_url=${remoteUrl} id=${insertRepoResult.rows[0].id}`,
      );
    } else {
      console.log(`[provision] repo already existed: remote_url=${remoteUrl}`);
    }

    // -----------------------------------------------------------------------
    // 3. app_user(s) — unique key: idp_subject
    //    email has a UNIQUE constraint too; if an existing row has a different
    //    email for the same idp_subject the insert would be a no-op and we'd
    //    still resolve the id by idp_subject (the Gate-2 lookup key).
    // -----------------------------------------------------------------------

    const userIds = new Map<string, string>(); // idp_subject → user.id

    for (const user of input.users) {
      const insertUserResult = await client.query<{ id: string }>(
        `INSERT INTO app_user (idp_subject, email)
         VALUES ($1, $2)
         ON CONFLICT (idp_subject) DO NOTHING
         RETURNING id`,
        [user.idp_subject, user.email],
      );

      let userId: string;
      if (insertUserResult.rows.length > 0) {
        userId = insertUserResult.rows[0].id;
        console.log(
          `[provision] app_user created:` +
            ` idp_subject=${user.idp_subject} email=${user.email} id=${userId}`,
        );
      } else {
        const sel = await client.query<{ id: string }>(
          'SELECT id FROM app_user WHERE idp_subject = $1',
          [user.idp_subject],
        );
        userId = sel.rows[0].id;
        console.log(
          `[provision] app_user already existed:` +
            ` idp_subject=${user.idp_subject} id=${userId}`,
        );
      }

      userIds.set(user.idp_subject, userId);
    }

    // -----------------------------------------------------------------------
    // 4. project_membership(s) — unique key: (project_id, user_id)
    // -----------------------------------------------------------------------

    for (const user of input.users) {
      // Non-null assertion is safe: every user was resolved in step 3.
      const userId = userIds.get(user.idp_subject)!;

      const insertMemberResult = await client.query<{ id: string }>(
        `INSERT INTO project_membership (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO NOTHING
         RETURNING id`,
        [projectId, userId, user.role],
      );

      if (insertMemberResult.rows.length > 0) {
        console.log(
          `[provision] project_membership created:` +
            ` project=${slug} user=${user.idp_subject} role=${user.role}` +
            ` id=${insertMemberResult.rows[0].id}`,
        );
      } else {
        console.log(
          `[provision] project_membership already existed:` +
            ` project=${slug} user=${user.idp_subject}`,
        );
      }
    }

    await client.query('COMMIT');
    console.log('[provision] Done. All rows provisioned (created or already existed).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[provision] Failed — transaction rolled back:', err);
    throw err;
  } finally {
    client.release();
    await closePool(pool);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — same guard pattern as migrate.ts / seed.ts.
// Only runs when this file is the main module, so imports have no side effects.
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.env.PROVISION_JSON;
  if (!raw) {
    console.error('[provision] PROVISION_JSON environment variable is required but not set.');
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[provision] PROVISION_JSON is not valid JSON.');
    process.exit(1);
  }

  const result = ProvisionSchema.safeParse(parsed);
  if (!result.success) {
    console.error(
      '[provision] PROVISION_JSON failed schema validation:',
      JSON.stringify(result.error.format(), null, 2),
    );
    process.exit(1);
  }

  runProvision(process.env.DATABASE_URL ?? '', result.data).catch(() => process.exit(1));
}
