/**
 * T028: Repository integration test — PgStagingRepository
 *
 * SKIPPED when `process.env.DATABASE_URL` is unset (mirrors 0001/0002 tests).
 * When a real Postgres connection string is provided this test exercises the
 * four PgStagingRepository methods against a live DB:
 *
 *  1. findOrCreateOpenSession — two calls for the same tenant key return the
 *     same session id (upsert + re-select idempotency / race safety).
 *  2. insertStagingItem — inserting twice with the same content_hash returns
 *     one DB row; the second call returns deduped:true with the pre-existing id.
 *  3. listStagingItems — returns only items from the caller's own open session;
 *     a second project+repo seed proves cross-session scoping.
 *  4. discardStagingItem — deletes only within the caller's own open session;
 *     returns false for a non-existent id and for an id in another session.
 *
 * Seeds: two independent (project, repo) pairs are created in beforeAll and
 * deleted (with ON DELETE CASCADE propagation) in afterAll. The staging tables
 * are NOT dropped here — that is the responsibility of staging.migrate.
 * integration.test.ts which also removes the '0003_staging' ledger entry.
 *
 * Prerequisites: Postgres 16 reachable at DATABASE_URL with CREATE privileges.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { StagingRepository } from '../../src/db/stagingRepository.js';

// ---------------------------------------------------------------------------
// Skip guard — entire suite is skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const PROJECT_SLUG_1 = 'staging-repo-integ-1';
const PROJECT_SLUG_2 = 'staging-repo-integ-2';
const REPO_URL_1 = 'https://github.com/test/staging-repo-integ-1';
const REPO_URL_2 = 'https://github.com/test/staging-repo-integ-2';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithDb('PgStagingRepository integration', () => {
  let pool: pg.Pool | undefined;
  let repo: StagingRepository | undefined;

  let projectId1: string;
  let repoId1: string;
  let projectId2: string;
  let repoId2: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (0001 → 0002 → 0003; idempotent).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    // Instantiate the repository under test.
    const { PgStagingRepository } = await import('../../src/db/stagingRepository.js');
    repo = new PgStagingRepository(pool);

    // -- Seed: project 1 + repo 1 --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Staging Repo Integration Test 1')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG_1],
    );
    const { rows: proj1Rows } = await pool.query(
      `SELECT id FROM project WHERE slug = $1`,
      [PROJECT_SLUG_1],
    );
    projectId1 = proj1Rows[0].id as string;

    await pool.query(
      `INSERT INTO repo (project_id, remote_url)
       VALUES ($1, $2)
       ON CONFLICT (remote_url) DO NOTHING`,
      [projectId1, REPO_URL_1],
    );
    const { rows: repo1Rows } = await pool.query(
      `SELECT id FROM repo WHERE remote_url = $1`,
      [REPO_URL_1],
    );
    repoId1 = repo1Rows[0].id as string;

    // -- Seed: project 2 + repo 2 (second tenant for scoping tests) --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Staging Repo Integration Test 2')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG_2],
    );
    const { rows: proj2Rows } = await pool.query(
      `SELECT id FROM project WHERE slug = $1`,
      [PROJECT_SLUG_2],
    );
    projectId2 = proj2Rows[0].id as string;

    await pool.query(
      `INSERT INTO repo (project_id, remote_url)
       VALUES ($1, $2)
       ON CONFLICT (remote_url) DO NOTHING`,
      [projectId2, REPO_URL_2],
    );
    const { rows: repo2Rows } = await pool.query(
      `SELECT id FROM repo WHERE remote_url = $1`,
      [REPO_URL_2],
    );
    repoId2 = repo2Rows[0].id as string;
  });

  afterAll(async () => {
    if (!pool) return;

    // Delete test project rows — cascades to repo, staging_session, staging_item
    // (all FK chains carry ON DELETE CASCADE).
    await pool.query(
      `DELETE FROM project WHERE slug IN ($1, $2)`,
      [PROJECT_SLUG_1, PROJECT_SLUG_2],
    );

    await pool.end();
  });

  // -------------------------------------------------------------------------
  // findOrCreateOpenSession — upsert + re-select idempotency
  //
  // Two consecutive calls for the same (project, repo, branch) must return
  // the SAME session id, regardless of which internal path was taken.
  // -------------------------------------------------------------------------

  it('two findOrCreateOpenSession calls for the same key return the same id', async () => {
    const tenant = { projectId: projectId1, repoId: repoId1, branch: 'test-upsert-main' };

    const id1 = await repo!.findOrCreateOpenSession(tenant, 'integ-test-user');
    const id2 = await repo!.findOrCreateOpenSession(tenant, 'integ-test-user');

    // Both calls resolve to the same session.
    expect(id1).toBe(id2);
    // ULID is 26 characters.
    expect(id1).toHaveLength(26);
  });

  // -------------------------------------------------------------------------
  // insertStagingItem — deduplication on (session_id, content_hash)
  //
  // Inserting twice with identical params must produce ONE row in the DB.
  // The second call returns { deduped: true } with the same id and judgeState.
  // -------------------------------------------------------------------------

  it('insertStagingItem twice with the same content_hash returns one row and deduped:true', async () => {
    const tenant = { projectId: projectId1, repoId: repoId1, branch: 'test-dedup-branch' };
    const sessionId = await repo!.findOrCreateOpenSession(tenant, 'integ-test-user');

    const params = {
      op: 'add' as const,
      type: 'decision' as const,
      title: 'Dedup integration test',
      summary: 'Summary for the dedup integration test.',
      body: 'Body text for the dedup integration test.',
      fields: {},
      contentHash: 'integ-dedup-content-hash-001',
      targetMemoryId: null,
      targetRevision: null,
      judgeState: 'pending' as const,
      authorIdentity: 'integ-test-user',
    };

    const result1 = await repo!.insertStagingItem(sessionId, params);
    const result2 = await repo!.insertStagingItem(sessionId, params);

    // First insert creates a new row.
    expect(result1.deduped).toBe(false);
    expect(result1.judgeState).toBe('pending');

    // Second insert returns the pre-existing row — same id and state.
    expect(result2.deduped).toBe(true);
    expect(result2.id).toBe(result1.id);
    expect(result2.judgeState).toBe(result1.judgeState);

    // Confirm only one DB row exists for this (session, hash) pair.
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM staging_item
        WHERE session_id = $1 AND content_hash = $2`,
      [sessionId, params.contentHash],
    );
    expect(rows[0].cnt).toBe(1);
  });

  // -------------------------------------------------------------------------
  // listStagingItems — cross-session scoping
  //
  // Each project/repo/branch combination has its own open session. Items from
  // project-1 must NOT appear in project-2's list and vice-versa.
  // -------------------------------------------------------------------------

  it('listStagingItems returns only the caller-key session items (scoped by project/repo/branch)', async () => {
    const tenant1 = { projectId: projectId1, repoId: repoId1, branch: 'test-list-scope' };
    const tenant2 = { projectId: projectId2, repoId: repoId2, branch: 'test-list-scope' };

    // Create sessions for both tenants.
    const sessionId1 = await repo!.findOrCreateOpenSession(tenant1, 'integ-test-user');
    const sessionId2 = await repo!.findOrCreateOpenSession(tenant2, 'integ-test-user');

    // Insert one item into project-1's session.
    await repo!.insertStagingItem(sessionId1, {
      op: 'add',
      type: 'decision',
      title: 'Project1 scoping item',
      summary: 'Summary for scoping test project 1.',
      body: 'Body for scoping test project 1.',
      fields: {},
      contentHash: 'integ-scope-hash-proj1',
      targetMemoryId: null,
      targetRevision: null,
      judgeState: 'pending',
      authorIdentity: 'integ-test-user',
    });

    // Insert one item into project-2's session.
    await repo!.insertStagingItem(sessionId2, {
      op: 'add',
      type: 'pattern',
      title: 'Project2 scoping item',
      summary: 'Summary for scoping test project 2.',
      body: 'Body for scoping test project 2.',
      fields: {},
      contentHash: 'integ-scope-hash-proj2',
      targetMemoryId: null,
      targetRevision: null,
      judgeState: 'pending',
      authorIdentity: 'integ-test-user',
    });

    // List for tenant1 must contain only project-1's item.
    const items1 = await repo!.listStagingItems(tenant1);
    const titles1 = items1.map((i) => i.title);
    expect(titles1).toContain('Project1 scoping item');
    expect(titles1).not.toContain('Project2 scoping item');

    // List for tenant2 must contain only project-2's item.
    const items2 = await repo!.listStagingItems(tenant2);
    const titles2 = items2.map((i) => i.title);
    expect(titles2).toContain('Project2 scoping item');
    expect(titles2).not.toContain('Project1 scoping item');
  });

  // -------------------------------------------------------------------------
  // discardStagingItem — ownership boundary enforcement
  //
  // discardStagingItem must return:
  //   true   — item exists in the caller's own open session and was deleted
  //   false  — item not found (non-existent id)
  //   false  — item belongs to a different session (cross-tenant)
  // -------------------------------------------------------------------------

  it('discardStagingItem deletes within the caller open session and returns false otherwise', async () => {
    const tenant1 = { projectId: projectId1, repoId: repoId1, branch: 'test-discard' };
    const tenant2 = { projectId: projectId2, repoId: repoId2, branch: 'test-discard' };

    // Create an open session for both tenants.
    const sessionId1 = await repo!.findOrCreateOpenSession(tenant1, 'integ-test-user');
    // Create a session for tenant2 as well (so it has a real open session, making
    // the cross-session discard attempt more realistic).
    await repo!.findOrCreateOpenSession(tenant2, 'integ-test-user');

    // Insert an item into tenant1's session.
    const { id: itemId } = await repo!.insertStagingItem(sessionId1, {
      op: 'add',
      type: 'gotcha',
      title: 'Discard integration item',
      summary: 'Summary for discard integration test.',
      body: 'Body for discard integration test.',
      fields: {},
      contentHash: 'integ-discard-hash-001',
      targetMemoryId: null,
      targetRevision: null,
      judgeState: 'pending',
      authorIdentity: 'integ-test-user',
    });

    // Attempting to discard via a different tenant (tenant2) returns false —
    // the item is outside that tenant's open session.
    const resultCrossTenant = await repo!.discardStagingItem(tenant2, itemId);
    expect(resultCrossTenant).toBe(false);

    // Attempting to discard a non-existent id returns false.
    const resultNotFound = await repo!.discardStagingItem(
      tenant1,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(resultNotFound).toBe(false);

    // Item must still be present after the failed attempts.
    const itemsBefore = await repo!.listStagingItems(tenant1);
    expect(itemsBefore.some((i) => i.id === itemId)).toBe(true);

    // Discarding with the correct tenant returns true and removes the item.
    const resultOk = await repo!.discardStagingItem(tenant1, itemId);
    expect(resultOk).toBe(true);

    // Verify the item is no longer in the caller's session.
    const itemsAfter = await repo!.listStagingItems(tenant1);
    expect(itemsAfter.some((i) => i.id === itemId)).toBe(false);
  });
});
