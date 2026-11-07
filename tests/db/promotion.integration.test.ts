/**
 * T021: PgPromotionRepository integration tests
 *
 * SKIPPED when DATABASE_URL is not set (no real Postgres available).
 * When a real Postgres connection string is provided, this exercises
 * PgPromotionRepository against a migrated DB (0001–0004):
 *
 *  - findOpenSessionId: returns id for existing open session; null for unknown branch.
 *  - fetchPromotableItems: excludes items where promoted_at IS NOT NULL.
 *  - applyAccepted (add): memory(active, revision=1, provenance=pr_reviewed) +
 *      memory_revision(1,'add'); content_tsv populated (GENERATED ALWAYS).
 *  - applyAccepted (add) dedup: second apply with same content_hash →
 *      no new memory/revision, deduped=true, promoted_memory_id = existing id.
 *  - applyAccepted idempotent: second call on same item → { status:'already' },
 *      no second memory/revision row.
 *  - applyAccepted (amend): target current_revision++ + memory_revision('amend').
 *  - applyAccepted (amend) stale: target_revision mismatch →
 *      { status:'stale' }, memory untouched.
 *  - applyAccepted (supersede): new memory + old status='superseded' +
 *      memory_relation(supersedes,'judge').
 *  - supersede re-run: ON CONFLICT DO NOTHING on memory_relation → no duplicate edge.
 *  - applyAccepted (deprecate): target status='deprecated', current_revision++,
 *      memory_revision('deprecate') uses snapshotted target content.
 *  - quarantineItem: quarantine row (self-contained) + staging_item.judge_state='rejected'.
 *  - quarantineItem redact=true: content replaced with sentinel string.
 *  - finalizeSession: promoted / rejected / partially_promoted transitions;
 *      second call on already-finalized session is a no-op.
 *
 * Prerequisites: Postgres 16 at DATABASE_URL with CREATE privileges.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type {
  PromotionItemRow,
  ApplyContext,
  QuarantineInput,
  PersistedDecision,
} from '../../src/db/promotionRepository.js';
import { toOrQuery } from '../../src/db/promotionRepository.js';
import { computeContentHash } from '../../src/security/hash.js';

// ---------------------------------------------------------------------------
// Skip guard — entire suite is skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const PROJECT_SLUG = 'promotion-repo-integ-test';
const REPO_URL = 'https://github.com/test/promotion-repo-integ-test';

// Session IDs — staging_session.id is text PRIMARY KEY; any unique string is valid.
const SESS_MAIN = 'promo-integ-main-sess-01';
const SESS_DEDUP = 'promo-integ-dedup-sess-01';
const SESS_RERUN = 'promo-integ-rerun-sess-01';
const SESS_FIN_PROMOTED = 'promo-integ-fin-promoted-01';
const SESS_FIN_REJECTED = 'promo-integ-fin-rejected-01';
const SESS_FIN_PARTIAL = 'promo-integ-fin-partial-01';
const SESS_FIN_NOOP = 'promo-integ-fin-noop-01';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithDb('PgPromotionRepository integration', () => {
  let pool: pg.Pool | undefined;
  // Use 'any' to avoid import complications with ESM dynamic imports at type level.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  let projectId: string;
  let repoId: string;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Insert a staging_item with op='add' into the given session.
   * Returns the item id (ON CONFLICT re-selects the existing row).
   */
  async function insertAddItem(params: {
    sessionId: string;
    contentHash: string;
    title?: string;
    summary?: string;
    body?: string;
    fields?: Record<string, unknown>;
  }): Promise<string> {
    const title = params.title ?? 'Integration test add title';
    const summary = params.summary ?? 'Integration test add summary text.';
    const body = params.body ?? 'Integration test add body. Enough for the test.';

    const { rows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity, fields)
       VALUES ($1, 'add', 'pattern', $2, $3, $4, $5, 'integ-test-user', $6::jsonb)
       ON CONFLICT (session_id, content_hash) DO NOTHING
       RETURNING id`,
      [params.sessionId, title, summary, body, params.contentHash, JSON.stringify(params.fields ?? {})],
    );
    if (rows.length > 0) return rows[0].id as string;
    const { rows: existing } = await pool!.query(
      `SELECT id FROM staging_item WHERE session_id = $1 AND content_hash = $2`,
      [params.sessionId, params.contentHash],
    );
    return existing[0].id as string;
  }

  /**
   * Insert a staging_item with op in ('amend'|'supersede'|'deprecate').
   * Requires target_memory_id + target_revision (CHECK constraint enforces this).
   */
  async function insertTargetItem(params: {
    sessionId: string;
    op: 'amend' | 'supersede' | 'deprecate';
    contentHash: string;
    targetMemoryId: string;
    targetRevision: number;
    title?: string;
    summary?: string;
    body?: string;
  }): Promise<string> {
    const title = params.title ?? 'Integration target item title';
    const summary = params.summary ?? 'Integration target item summary text.';
    const body = params.body ?? 'Integration target item body content here.';

    const { rows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash,
          target_memory_id, target_revision, author_identity)
       VALUES ($1, $2, 'pattern', $3, $4, $5, $6, $7, $8, 'integ-test-user')
       ON CONFLICT (session_id, content_hash) DO NOTHING
       RETURNING id`,
      [
        params.sessionId, params.op, title, summary, body,
        params.contentHash, params.targetMemoryId, params.targetRevision,
      ],
    );
    if (rows.length > 0) return rows[0].id as string;
    const { rows: existing } = await pool!.query(
      `SELECT id FROM staging_item WHERE session_id = $1 AND content_hash = $2`,
      [params.sessionId, params.contentHash],
    );
    return existing[0].id as string;
  }

  /**
   * Insert a memory row directly (bypasses the promotion pipeline).
   * Used to seed prerequisite target rows for amend/supersede/deprecate tests.
   */
  async function insertMemory(params: {
    contentHash: string;
    title?: string;
    summary?: string;
    body?: string;
  }): Promise<string> {
    const title = params.title ?? 'Direct seed memory title';
    const summary = params.summary ?? 'Direct seed memory summary.';
    const body = params.body ?? 'Direct seed memory body content for testing.';

    const { rows } = await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash)
       VALUES ($1, $2, 'pattern', $3, $4, $5,
               'active', 'pr_reviewed', 'seed-user', $6)
       ON CONFLICT (project_id, content_hash) DO NOTHING
       RETURNING id`,
      [projectId, repoId, title, summary, body, params.contentHash],
    );
    if (rows.length > 0) return rows[0].id as string;
    const { rows: existing } = await pool!.query(
      `SELECT id FROM memory WHERE project_id = $1 AND content_hash = $2`,
      [projectId, params.contentHash],
    );
    return existing[0].id as string;
  }

  /**
   * Fetch a single PromotionItemRow by id from the promotable-items list.
   * Throws if not found (test setup error).
   */
  async function fetchItem(sessionId: string, itemId: string): Promise<PromotionItemRow> {
    const items: PromotionItemRow[] = await repo!.fetchPromotableItems(sessionId, projectId);
    const item = items.find((i) => i.id === itemId);
    if (!item) throw new Error(`Item ${itemId} not found in session ${sessionId} promotable items`);
    return item;
  }

  // -------------------------------------------------------------------------
  // beforeAll — migrate + seed
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (0001 → 0004; idempotent).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    // Instantiate repository under test.
    const { PgPromotionRepository } = await import('../../src/db/promotionRepository.js');
    repo = new PgPromotionRepository(pool);

    // -- Seed: project --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Promotion Repository Integration Test')
       ON CONFLICT (slug) DO NOTHING`,
      [PROJECT_SLUG],
    );
    const { rows: projRows } = await pool.query(
      `SELECT id FROM project WHERE slug = $1`,
      [PROJECT_SLUG],
    );
    projectId = projRows[0].id as string;

    // -- Seed: repo --
    await pool.query(
      `INSERT INTO repo (project_id, remote_url)
       VALUES ($1, $2)
       ON CONFLICT (remote_url) DO NOTHING`,
      [projectId, REPO_URL],
    );
    const { rows: repoRows } = await pool.query(
      `SELECT id FROM repo WHERE remote_url = $1`,
      [REPO_URL],
    );
    repoId = repoRows[0].id as string;

    // -- Seed: main open session (shared by most tests) --
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, 'main', 'integ-test-user')
       ON CONFLICT DO NOTHING`,
      [SESS_MAIN, projectId, repoId],
    );

    // -- Seed: additional open sessions (each needs a distinct branch because of
    //    the partial unique index ux_session_open on (project, repo, branch) WHERE open) --
    const extraSessions: Array<[string, string]> = [
      [SESS_DEDUP, 'dedup-branch'],
      [SESS_RERUN, 'rerun-branch'],
      [SESS_FIN_PROMOTED, 'fin-promoted-branch'],
      [SESS_FIN_REJECTED, 'fin-rejected-branch'],
      [SESS_FIN_PARTIAL, 'fin-partial-branch'],
      [SESS_FIN_NOOP, 'fin-noop-branch'],
    ];
    for (const [sid, branch] of extraSessions) {
      await pool.query(
        `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
         VALUES ($1, $2, $3, $4, 'integ-test-user')
         ON CONFLICT DO NOTHING`,
        [sid, projectId, repoId, branch],
      );
    }
  });

  // -------------------------------------------------------------------------
  // afterAll — idempotent teardown
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (!pool) return;

    // Remove staging items first: cascading the project delete would NULL
    // target_memory_id (ON DELETE SET NULL) on amend items and violate
    // ck_item_optarget. Remaining children (repo, memory, sessions, quarantine)
    // are removed by the project cascade.
    await pool.query(
      `DELETE FROM staging_item
        WHERE session_id IN (SELECT id FROM staging_session WHERE project_id =
              (SELECT id FROM project WHERE slug = $1))`,
      [PROJECT_SLUG],
    );
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);

    await pool.end();
  });

  // -------------------------------------------------------------------------
  // findOpenSessionId
  // -------------------------------------------------------------------------

  it('findOpenSessionId returns the open session id for a known branch', async () => {
    const found = await repo!.findOpenSessionId({
      projectId,
      repoId,
      branch: 'main',
    });
    expect(found).toBe(SESS_MAIN);
  });

  it('findOpenSessionId returns null for a branch with no open session', async () => {
    const found = await repo!.findOpenSessionId({
      projectId,
      repoId,
      branch: 'no-such-branch-xyz',
    });
    expect(found).toBeNull();
  });

  // -------------------------------------------------------------------------
  // applyAccepted — op='add'
  // -------------------------------------------------------------------------

  it('applyAccepted (add) inserts memory with correct shape and a populated content_tsv', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-add-001',
      title: 'Promotion pipeline add test',
      summary: 'Verifies add op inserts memory with correct provenance.',
      body: 'This memory was inserted by the applyAccepted integration test for the add operation.',
    });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const result = await repo!.applyAccepted(item, ctx, null, new Set());

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.deduped).toBe(false);
    expect(result.memoryId).toBeTruthy();

    // Memory row shape
    const { rows: memRows } = await pool!.query(
      `SELECT status, current_revision, provenance, content_tsv::text AS tsv
         FROM memory WHERE id = $1`,
      [result.memoryId],
    );
    expect(memRows).toHaveLength(1);
    expect(memRows[0].status).toBe('active');
    expect(memRows[0].current_revision).toBe(1);
    expect(memRows[0].provenance).toBe('pr_reviewed');
    // content_tsv is GENERATED ALWAYS — it must be non-empty even though we
    // never listed it in the INSERT column list.
    expect(memRows[0].tsv).toBeTruthy();

    // memory_revision row
    const { rows: revRows } = await pool!.query(
      `SELECT revision_no, op FROM memory_revision WHERE memory_id = $1`,
      [result.memoryId],
    );
    expect(revRows).toHaveLength(1);
    expect(revRows[0].revision_no).toBe(1);
    expect(revRows[0].op).toBe('add');

    // staging_item marked applied
    const { rows: itemRows } = await pool!.query(
      `SELECT promoted_at, promoted_memory_id, judge_state
         FROM staging_item WHERE id = $1`,
      [itemId],
    );
    expect(itemRows[0].promoted_at).not.toBeNull();
    expect(itemRows[0].promoted_memory_id).toBe(result.memoryId);
    expect(itemRows[0].judge_state).toBe('accepted');
  });

  // -------------------------------------------------------------------------
  // applyAccepted — add dedup (ON CONFLICT DO NOTHING path)
  // -------------------------------------------------------------------------

  it('applyAccepted (add) dedup: second item with same content_hash → deduped=true, no new rows', async () => {
    const HASH = 'promo-integ-add-dedup-001';

    // First item in SESS_MAIN
    const firstItemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: HASH,
      title: 'Dedup test memory title first',
      summary: 'Dedup test memory summary first.',
      body: 'Dedup test body. Unique enough for the first insertion.',
    });
    const firstItem = await fetchItem(SESS_MAIN, firstItemId);
    const ctx1: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };
    const firstResult = await repo!.applyAccepted(firstItem, ctx1, null, new Set());
    expect(firstResult.status).toBe('applied');
    const firstMemoryId = firstResult.status === 'applied' ? firstResult.memoryId : '';

    // Count before second apply
    const { rows: beforeMem } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM memory
         WHERE project_id = $1 AND content_hash = $2`,
      [projectId, HASH],
    );
    const memCountBefore = beforeMem[0].cnt as number;

    // Second item — same content_hash, different session (SESS_DEDUP already seeded)
    const secondItemId = await insertAddItem({
      sessionId: SESS_DEDUP,
      contentHash: HASH,
      title: 'Dedup test memory title first',
      summary: 'Dedup test memory summary first.',
      body: 'Dedup test body. Unique enough for the first insertion.',
    });
    const secondItem = await fetchItem(SESS_DEDUP, secondItemId);
    const ctx2: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'dedup-branch',
      originPr: null,
      sessionId: SESS_DEDUP,
    };

    const secondResult = await repo!.applyAccepted(secondItem, ctx2, null, new Set());
    expect(secondResult.status).toBe('applied');
    if (secondResult.status !== 'applied') return;
    expect(secondResult.deduped).toBe(true);
    expect(secondResult.memoryId).toBe(firstMemoryId);

    // No new memory row created
    const { rows: afterMem } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM memory
         WHERE project_id = $1 AND content_hash = $2`,
      [projectId, HASH],
    );
    expect(afterMem[0].cnt).toBe(memCountBefore);

    // Still only one memory_revision for that memory
    const { rows: revRows } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM memory_revision WHERE memory_id = $1`,
      [firstMemoryId],
    );
    expect(revRows[0].cnt).toBe(1);
  });

  // -------------------------------------------------------------------------
  // applyAccepted — idempotent (already applied)
  // -------------------------------------------------------------------------

  it('applyAccepted returns { status: already } on second call; no duplicate memory/revision', async () => {
    const HASH = 'promo-integ-already-001';
    const itemId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: HASH });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const first = await repo!.applyAccepted(item, ctx, null, new Set());
    expect(first.status).toBe('applied');

    // Pass the same item object — applyAccepted re-locks the row in DB and sees
    // promoted_at IS NOT NULL, so it returns { status: 'already' } without writing.
    const second = await repo!.applyAccepted(item, ctx, null, new Set());
    expect(second.status).toBe('already');

    // Still only one memory and one revision row
    if (first.status === 'applied') {
      const { rows } = await pool!.query(
        `SELECT COUNT(*)::int AS cnt FROM memory_revision WHERE memory_id = $1`,
        [first.memoryId],
      );
      expect(rows[0].cnt).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // applyAccepted — op='amend' (success)
  // -------------------------------------------------------------------------

  it('applyAccepted (amend) updates memory content, bumps current_revision, inserts revision', async () => {
    const targetMemoryId = await insertMemory({
      contentHash: 'promo-integ-amend-target-001',
      title: 'Memory to amend',
      summary: 'Original summary before amend.',
      body: 'Original body text before the amend operation is applied.',
    });

    const itemId = await insertTargetItem({
      sessionId: SESS_MAIN,
      op: 'amend',
      contentHash: 'promo-integ-amend-new-001',
      targetMemoryId,
      targetRevision: 1,
      title: 'Amended memory title',
      summary: 'Amended summary after the amend op.',
      body: 'Amended body text. This replaces the original body via applyAccepted.',
    });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const result = await repo!.applyAccepted(item, ctx, null, new Set());

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.memoryId).toBe(targetMemoryId);
    expect(result.deduped).toBe(false);

    // Memory current_revision bumped to 2; title updated
    const { rows: memRows } = await pool!.query(
      `SELECT current_revision, title FROM memory WHERE id = $1`,
      [targetMemoryId],
    );
    expect(memRows[0].current_revision).toBe(2);
    expect(memRows[0].title).toBe('Amended memory title');

    // memory_revision row: revision_no=2, op='amend'
    const { rows: revRows } = await pool!.query(
      `SELECT revision_no, op FROM memory_revision WHERE memory_id = $1`,
      [targetMemoryId],
    );
    expect(revRows).toHaveLength(1);
    expect(revRows[0].revision_no).toBe(2);
    expect(revRows[0].op).toBe('amend');
  });

  // -------------------------------------------------------------------------
  // applyAccepted — op='amend' stale
  // -------------------------------------------------------------------------

  it('applyAccepted (amend) returns { status: stale } when target_revision mismatches current', async () => {
    const targetMemoryId = await insertMemory({
      contentHash: 'promo-integ-amend-stale-001',
    });

    // target_revision=99 but DB has current_revision=1 → stale
    const itemId = await insertTargetItem({
      sessionId: SESS_MAIN,
      op: 'amend',
      contentHash: 'promo-integ-amend-stale-new-001',
      targetMemoryId,
      targetRevision: 99,
    });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const result = await repo!.applyAccepted(item, ctx, null, new Set());
    expect(result.status).toBe('stale');

    // Memory must be untouched
    const { rows: memRows } = await pool!.query(
      `SELECT current_revision FROM memory WHERE id = $1`,
      [targetMemoryId],
    );
    expect(memRows[0].current_revision).toBe(1);

    // No memory_revision row written
    const { rows: revRows } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM memory_revision WHERE memory_id = $1`,
      [targetMemoryId],
    );
    expect(revRows[0].cnt).toBe(0);
  });

  // -------------------------------------------------------------------------
  // applyAccepted — op='supersede'
  // -------------------------------------------------------------------------

  it('applyAccepted (supersede) creates new memory, marks old superseded, inserts relation', async () => {
    const oldMemoryId = await insertMemory({
      contentHash: 'promo-integ-supersede-old-001',
      title: 'Memory to supersede',
      summary: 'Will be superseded by a newer memory.',
      body: 'Original content to be superseded via the applyAccepted integration test.',
    });

    const itemId = await insertTargetItem({
      sessionId: SESS_MAIN,
      op: 'supersede',
      contentHash: 'promo-integ-supersede-new-001',
      targetMemoryId: oldMemoryId,
      targetRevision: 1,
      title: 'Superseding memory title',
      summary: 'This memory supersedes the old one.',
      body: 'New content that supersedes the original memory row in this integration test.',
    });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const result = await repo!.applyAccepted(item, ctx, null, new Set());

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.deduped).toBe(false);

    const newMemoryId = result.memoryId;
    expect(newMemoryId).not.toBe(oldMemoryId);

    // New memory is active, revision 1
    const { rows: newMem } = await pool!.query(
      `SELECT status, current_revision FROM memory WHERE id = $1`,
      [newMemoryId],
    );
    expect(newMem[0].status).toBe('active');
    expect(newMem[0].current_revision).toBe(1);

    // Old memory is superseded
    const { rows: oldMem } = await pool!.query(
      `SELECT status FROM memory WHERE id = $1`,
      [oldMemoryId],
    );
    expect(oldMem[0].status).toBe('superseded');

    // memory_relation: from=new, to=old, type=supersedes, source=judge
    const { rows: relRows } = await pool!.query(
      `SELECT relation_type, source FROM memory_relation
         WHERE from_memory = $1 AND to_memory = $2`,
      [newMemoryId, oldMemoryId],
    );
    expect(relRows).toHaveLength(1);
    expect(relRows[0].relation_type).toBe('supersedes');
    expect(relRows[0].source).toBe('judge');
  });

  // -------------------------------------------------------------------------
  // applyAccepted — supersede re-run (ON CONFLICT DO NOTHING on memory_relation)
  // -------------------------------------------------------------------------

  it('supersede re-run: inserting the same relation edge a second time is a no-op (no duplicate)', async () => {
    const oldMemoryId = await insertMemory({
      contentHash: 'promo-integ-supersede-rerun-old-001',
      title: 'Supersede rerun old memory',
      summary: 'Old memory for supersede rerun idempotency test.',
      body: 'Old body content used to verify ON CONFLICT DO NOTHING on memory_relation.',
    });

    const itemId = await insertTargetItem({
      sessionId: SESS_RERUN,
      op: 'supersede',
      contentHash: 'promo-integ-supersede-rerun-new-001',
      targetMemoryId: oldMemoryId,
      targetRevision: 1,
      title: 'Supersede rerun new memory title',
      summary: 'New memory for supersede rerun idempotency test.',
      body: 'New content. Tests that memory_relation ON CONFLICT DO NOTHING prevents duplicates.',
    });

    const item = await fetchItem(SESS_RERUN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'rerun-branch',
      originPr: null,
      sessionId: SESS_RERUN,
    };

    const first = await repo!.applyAccepted(item, ctx, null, new Set());
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') return;

    const newMemoryId = first.memoryId;

    // Attempt a duplicate insert — must silently do nothing (ON CONFLICT DO NOTHING).
    await pool!.query(
      `INSERT INTO memory_relation (from_memory, to_memory, relation_type, source)
       VALUES ($1, $2, 'supersedes', 'judge')
       ON CONFLICT (from_memory, to_memory, relation_type) DO NOTHING`,
      [newMemoryId, oldMemoryId],
    );

    // Only one edge must exist
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS cnt FROM memory_relation
         WHERE from_memory = $1 AND to_memory = $2 AND relation_type = 'supersedes'`,
      [newMemoryId, oldMemoryId],
    );
    expect(rows[0].cnt).toBe(1);
  });

  // -------------------------------------------------------------------------
  // applyAccepted — op='deprecate'
  // -------------------------------------------------------------------------

  it('applyAccepted (deprecate) flips status to deprecated, bumps revision, snapshots target content', async () => {
    const targetMemoryId = await insertMemory({
      contentHash: 'promo-integ-deprecate-target-001',
      title: 'Memory to deprecate',
      summary: 'Will be deprecated by the promotion pipeline.',
      body: 'Original body content before the deprecate operation is applied.',
    });

    const itemId = await insertTargetItem({
      sessionId: SESS_MAIN,
      op: 'deprecate',
      contentHash: 'promo-integ-deprecate-item-001',
      targetMemoryId,
      targetRevision: 1,
    });

    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    const result = await repo!.applyAccepted(item, ctx, null, new Set());

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.memoryId).toBe(targetMemoryId);

    // Memory: status='deprecated', current_revision=2
    const { rows: memRows } = await pool!.query(
      `SELECT status, current_revision FROM memory WHERE id = $1`,
      [targetMemoryId],
    );
    expect(memRows[0].status).toBe('deprecated');
    expect(memRows[0].current_revision).toBe(2);

    // memory_revision: revision_no=2, op='deprecate' (snapshotted target content)
    const { rows: revRows } = await pool!.query(
      `SELECT revision_no, op, title FROM memory_revision WHERE memory_id = $1`,
      [targetMemoryId],
    );
    expect(revRows).toHaveLength(1);
    expect(revRows[0].revision_no).toBe(2);
    expect(revRows[0].op).toBe('deprecate');
    // Snapshot uses the target's title, not the staging_item title
    expect(revRows[0].title).toBe('Memory to deprecate');
  });

  // -------------------------------------------------------------------------
  // quarantineItem
  // -------------------------------------------------------------------------

  it('quarantineItem inserts a row in quarantine and marks staging_item rejected', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-quarantine-001',
      title: 'Quarantine test title',
      summary: 'This item will be quarantined by the test.',
      body: 'Body content for the quarantine integration test case.',
    });

    // Fetch via direct SQL (item may have been quarantined before = judge_state='rejected'
    // so fetchPromotableItems would still return it since promoted_at IS NULL).
    const items: PromotionItemRow[] = await repo!.fetchPromotableItems(SESS_MAIN, projectId);
    const item = items.find((i) => i.id === itemId);
    expect(item).toBeTruthy();

    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    await repo!.quarantineItem(item!, ctx, {
      reason: 'judge_rejected',
      redact: false,
      decision: null,
      sanitizeFlags: {},
    } satisfies QuarantineInput);

    // Quarantine row exists with correct attribution
    const { rows: qRows } = await pool!.query(
      `SELECT title, summary, body, judge_reason, author_identity,
              origin_session_id, origin_item_id
         FROM quarantine
        WHERE origin_item_id = $1`,
      [itemId],
    );
    expect(qRows).toHaveLength(1);
    expect(qRows[0].title).toBe('Quarantine test title');
    expect(qRows[0].summary).toBe('This item will be quarantined by the test.');
    expect(qRows[0].judge_reason).toBe('judge_rejected');
    expect(qRows[0].author_identity).toBe('integ-test-user');
    expect(qRows[0].origin_session_id).toBe(SESS_MAIN);
    expect(qRows[0].origin_item_id).toBe(itemId);

    // Staging item marked terminal
    const { rows: itemRows } = await pool!.query(
      `SELECT judge_state FROM staging_item WHERE id = $1`,
      [itemId],
    );
    expect(itemRows[0].judge_state).toBe('rejected');
  });

  it('quarantineItem with redact=true replaces title/summary/body with sentinel', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-quarantine-redact-001',
      title: 'Title with AKIAIOSFODNN7EXAMPLE secret',
      summary: 'Summary containing some sensitive credential data.',
      body: 'Body containing -----BEGIN RSA PRIVATE KEY----- fake secret.',
    });

    const items: PromotionItemRow[] = await repo!.fetchPromotableItems(SESS_MAIN, projectId);
    const item = items.find((i) => i.id === itemId);
    expect(item).toBeTruthy();

    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };

    await repo!.quarantineItem(item!, ctx, {
      reason: 'secret_detected',
      redact: true,
      decision: null,
      sanitizeFlags: { leak: true, secrets: ['aws_access_key'] },
    });

    // Content must be replaced with redact sentinel
    const { rows: qRows } = await pool!.query(
      `SELECT title, summary, body, fields FROM quarantine WHERE origin_item_id = $1`,
      [itemId],
    );
    expect(qRows).toHaveLength(1);
    expect(qRows[0].title).toBe('[REDACTED: secret detected]');
    expect(qRows[0].summary).toBe('[REDACTED: secret detected]');
    expect(qRows[0].body).toBe('[REDACTED: secret detected]');
    // Security fix: the secret hidden in fields is blanked too.
    expect(qRows[0].fields).toEqual({});
  });

  it('quarantineItem with redact=true blanks fields in quarantine AND staging (secret in fields)', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-quarantine-redact-fields-001',
      fields: { note: 'AKIAIOSFODNN7EXAMPLE' },
    });
    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId, repoId, originBranch: 'main', originPr: null, sessionId: SESS_MAIN,
    };

    await repo!.quarantineItem(item, ctx, {
      reason: 'secret_detected',
      redact: true,
      decision: null,
      sanitizeFlags: { leak: true, secrets: ['aws_access_key'] },
    });

    const { rows: q } = await pool!.query(
      `SELECT fields FROM quarantine WHERE origin_item_id = $1`, [itemId],
    );
    expect(q[0].fields).toEqual({});

    const { rows: st } = await pool!.query(
      `SELECT title, summary, body, fields, judge_state, sanitize_flags, content_hash
         FROM staging_item WHERE id = $1`,
      [itemId],
    );
    expect(st[0].fields).toEqual({});
    expect(st[0].title).toBe('[REDACTED: secret detected]');
    expect(st[0].body).toBe('[REDACTED: secret detected]');
    expect(st[0].judge_state).toBe('rejected');
    expect(st[0].sanitize_flags).toEqual({ leak: true, secrets: ['aws_access_key'] });
    // content_hash is untouched on terminal rows
    expect(st[0].content_hash).toBe('promo-integ-quarantine-redact-fields-001');
  });

  it('quarantineItem writes the decision columns on the staging row', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-quarantine-decision-001',
    });
    const item = await fetchItem(SESS_MAIN, itemId);
    const ctx: ApplyContext = {
      projectId, repoId, originBranch: 'main', originPr: null, sessionId: SESS_MAIN,
    };
    const relatedId = await insertMemory({ contentHash: 'promo-integ-quarantine-related-mem' });

    await repo!.quarantineItem(item, ctx, {
      reason: 'duplicate_content',
      redact: false,
      decision: {
        verdict: 'rejected',
        criterion: 'duplication',
        confidence: 0.95,
        reason: 'duplicate_content',
        relatedMemoryId: relatedId,
        mandatoryReview: false,
      },
      sanitizeFlags: { pii: ['email'] },
    });

    const { rows } = await pool!.query(
      `SELECT judge_state, judge_reason, judge_criterion, judge_confidence,
              related_memory_id, mandatory_review, sanitize_flags
         FROM staging_item WHERE id = $1`,
      [itemId],
    );
    expect(rows[0].judge_state).toBe('rejected');
    expect(rows[0].judge_criterion).toBe('duplication');
    expect(rows[0].judge_confidence).toBeCloseTo(0.95, 5);
    expect(rows[0].related_memory_id).toBe(relatedId);
    expect(rows[0].mandatory_review).toBe(false);
    expect(rows[0].sanitize_flags).toEqual({ pii: ['email'] });
  });

  // -------------------------------------------------------------------------
  // recordDecision
  // -------------------------------------------------------------------------

  it('recordDecision round-trips the decision columns (real 0.8 reads back 0.8)', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-record-decision-001',
    });
    const decision: PersistedDecision = {
      verdict: 'uncertain',
      criterion: 'confidence',
      confidence: 0.8,
      reason: 'low confidence',
      relatedMemoryId: null,
      mandatoryReview: true,
    };
    await repo!.recordDecision(itemId, decision, { pii: ['phone'] });

    const item = await fetchItem(SESS_MAIN, itemId);
    expect(item.judge_state).toBe('uncertain');
    expect(item.judge_reason).toBe('low confidence');
    expect(item.judge_criterion).toBe('confidence');
    expect(item.judge_confidence).toBe(0.8);
    expect(item.mandatory_review).toBe(true);
    expect(item.related_memory_id).toBeNull();
    expect(item.sanitize_flags).toEqual({ pii: ['phone'] });
  });

  // -------------------------------------------------------------------------
  // fetchPromotableItems — reviewed items excluded
  // -------------------------------------------------------------------------

  it('fetchPromotableItems excludes items with reviewed_at set', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-reviewed-001',
    });
    expect((await repo!.fetchPromotableItems(SESS_MAIN, projectId)).some((i) => i.id === itemId)).toBe(true);

    await pool!.query(`UPDATE staging_item SET reviewed_at = now() WHERE id = $1`, [itemId]);
    expect((await repo!.fetchPromotableItems(SESS_MAIN, projectId)).some((i) => i.id === itemId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // persistMasked
  // -------------------------------------------------------------------------

  it('persistMasked updates content, hash and flags; reports hash_conflict on duplicate hash', async () => {
    const idA = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-mask-a' });
    const idB = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-mask-b' });
    const masked = { title: 'T [EMAIL]', summary: 'S [PHONE]', body: 'B [ID]', fields: { k: '[EMAIL]' } };

    const ok = await repo!.persistMasked(idA, masked, 'promo-integ-mask-a-new', { pii: ['email'] });
    expect(ok).toBe('ok');

    const { rows } = await pool!.query(
      `SELECT title, summary, body, fields, content_hash, sanitize_flags FROM staging_item WHERE id = $1`,
      [idA],
    );
    expect(rows[0]).toMatchObject({
      title: 'T [EMAIL]', summary: 'S [PHONE]', body: 'B [ID]',
      fields: { k: '[EMAIL]' }, content_hash: 'promo-integ-mask-a-new',
      sanitize_flags: { pii: ['email'] },
    });

    // idB masked to the same hash within the same session -> UNIQUE violation
    const conflict = await repo!.persistMasked(idB, masked, 'promo-integ-mask-a-new', { pii: ['email'] });
    expect(conflict).toBe('hash_conflict');
    const { rows: bRows } = await pool!.query(
      `SELECT content_hash FROM staging_item WHERE id = $1`, [idB],
    );
    expect(bRows[0].content_hash).toBe('promo-integ-mask-b');
  });

  // -------------------------------------------------------------------------
  // findJudgeContext / toOrQuery
  // -------------------------------------------------------------------------

  it('toOrQuery lowercases, drops short tokens, dedupes, caps at 16 and returns [] when empty', () => {
    expect(toOrQuery('The Cache TTL', 'cache is on')).toEqual(['the or cache or ttl']);
    expect(toOrQuery('a b', 'to it')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `tok${i}`).join(' ');
    expect(toOrQuery(many, '')[0]!.split(' or ')).toHaveLength(16);
  });

  it('findJudgeContext returns <=3 active same-project matches, excludes the target, empty tokens -> []', async () => {
    const word = 'zorblaxcontext';
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await insertMemory({
        contentHash: `promo-integ-ctx-${i}`,
        title: `${word} memory ${i}`,
        summary: `About ${word} number ${i}.`,
        body: `Body for ${word} ${i}.`,
      }));
    }
    // Non-active memory must not appear.
    const deprecatedId = await insertMemory({
      contentHash: 'promo-integ-ctx-deprecated',
      title: `${word} deprecated`,
      summary: `${word} deprecated summary.`,
    });
    await pool!.query(`UPDATE memory SET status = 'deprecated' WHERE id = $1`, [deprecatedId]);

    const ctxItems = await repo!.findJudgeContext(projectId, { title: word, summary: '' }, null);
    expect(ctxItems.length).toBeLessThanOrEqual(3);
    expect(ctxItems.length).toBe(3);
    for (const c of ctxItems) {
      expect(ids).toContain(c.id);
      expect(c.id).not.toBe(deprecatedId);
      expect(Object.keys(c).sort()).toEqual(['id', 'summary', 'title', 'type']);
    }

    const excluded = await repo!.findJudgeContext(projectId, { title: word, summary: '' }, ctxItems[0]!.id);
    expect(excluded.some((c: { id: string }) => c.id === ctxItems[0]!.id)).toBe(false);

    expect(await repo!.findJudgeContext(projectId, { title: 'a b', summary: 'it' }, null)).toEqual([]);
  });

  it('findJudgeContext is project-scoped', async () => {
    const other = 'promotion-repo-integ-test-other';
    await pool!.query(
      `INSERT INTO project (slug, name) VALUES ($1, 'Other') ON CONFLICT (slug) DO NOTHING`, [other],
    );
    const { rows: pr } = await pool!.query(`SELECT id FROM project WHERE slug = $1`, [other]);
    const otherProject = pr[0].id as string;
    try {
      await pool!.query(
        `INSERT INTO memory (project_id, type, title, summary, body, status, provenance,
                             author_identity, content_hash)
         VALUES ($1, 'pattern', 'quxscopedword title', 'quxscopedword summary', 'body',
                 'active', 'pr_reviewed', 'seed-user', 'promo-integ-scope-other')`,
        [otherProject],
      );
      const mine = await repo!.findJudgeContext(projectId, { title: 'quxscopedword', summary: '' }, null);
      expect(mine).toEqual([]);
      const theirs = await repo!.findJudgeContext(otherProject, { title: 'quxscopedword', summary: '' }, null);
      expect(theirs).toHaveLength(1);
    } finally {
      await pool!.query(`DELETE FROM project WHERE slug = $1`, [other]);
    }
  });

  // -------------------------------------------------------------------------
  // finalizeSession
  // -------------------------------------------------------------------------

  it('finalizeSession transitions an open session to promoted', async () => {
    await repo!.finalizeSession(SESS_FIN_PROMOTED, 'promoted');

    const { rows } = await pool!.query(
      `SELECT status, promoted_at FROM staging_session WHERE id = $1`,
      [SESS_FIN_PROMOTED],
    );
    expect(rows[0].status).toBe('promoted');
    expect(rows[0].promoted_at).not.toBeNull();
  });

  it('finalizeSession transitions an open session to rejected', async () => {
    await repo!.finalizeSession(SESS_FIN_REJECTED, 'rejected');

    const { rows } = await pool!.query(
      `SELECT status FROM staging_session WHERE id = $1`,
      [SESS_FIN_REJECTED],
    );
    expect(rows[0].status).toBe('rejected');
  });

  it('finalizeSession transitions an open session to partially_promoted', async () => {
    await repo!.finalizeSession(SESS_FIN_PARTIAL, 'partially_promoted');

    const { rows } = await pool!.query(
      `SELECT status FROM staging_session WHERE id = $1`,
      [SESS_FIN_PARTIAL],
    );
    expect(rows[0].status).toBe('partially_promoted');
  });

  it('finalizeSession is a no-op on an already-finalized session (first writer wins)', async () => {
    await repo!.finalizeSession(SESS_FIN_NOOP, 'promoted');
    // Second call with a different status should not overwrite
    await repo!.finalizeSession(SESS_FIN_NOOP, 'rejected');

    const { rows } = await pool!.query(
      `SELECT status FROM staging_session WHERE id = $1`,
      [SESS_FIN_NOOP],
    );
    expect(rows[0].status).toBe('promoted'); // first finalize wins
  });

  // -------------------------------------------------------------------------
  // fetchPromotableItems — excludes promoted items
  // -------------------------------------------------------------------------

  it('fetchPromotableItems excludes items after they are applied (promoted_at IS NOT NULL)', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-fetch-exclude-001',
    });

    // Must appear before apply
    const before: PromotionItemRow[] = await repo!.fetchPromotableItems(SESS_MAIN, projectId);
    expect(before.some((i) => i.id === itemId)).toBe(true);

    // Apply it
    const item = before.find((i) => i.id === itemId)!;
    const ctx: ApplyContext = {
      projectId,
      repoId,
      originBranch: 'main',
      originPr: null,
      sessionId: SESS_MAIN,
    };
    await repo!.applyAccepted(item, ctx, null, new Set());

    // Must NOT appear after apply (promoted_at IS NOT NULL)
    const after: PromotionItemRow[] = await repo!.fetchPromotableItems(SESS_MAIN, projectId);
    expect(after.some((i) => i.id === itemId)).toBe(false);
  });
  // -------------------------------------------------------------------------
  // Verify-round-1 remediation (task 5.1)
  // -------------------------------------------------------------------------

  const mainCtx = (): ApplyContext => ({
    projectId, repoId, originBranch: 'main', originPr: null, sessionId: SESS_MAIN,
  });

  async function insertTypedMemory(type: string, contentHash: string): Promise<string> {
    const { rows } = await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash)
       VALUES ($1, $2, $3, 'Typed seed memory', 'Typed seed summary.', 'Typed seed body.',
               'active', 'pr_reviewed', 'seed-user', $4)
       RETURNING id`,
      [projectId, repoId, type, contentHash],
    );
    return rows[0].id as string;
  }

  async function insertTypedAmend(type: string, contentHash: string, targetId: string): Promise<string> {
    const { rows } = await pool!.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash,
          target_memory_id, target_revision, author_identity)
       VALUES ($1, 'amend', $2, 'Typed amend title', 'Typed amend summary.', 'Typed amend body.',
               $3, $4, 1, 'integ-test-user')
       RETURNING id`,
      [SESS_MAIN, type, contentHash, targetId],
    );
    return rows[0].id as string;
  }

  it('SEC M-1: fetchPromotableItems exposes the target memory type', async () => {
    const memId = await insertTypedMemory('decision', 'promo-integ-m1-fetch-mem');
    const itemId = await insertTypedAmend('decision', 'promo-integ-m1-fetch-item', memId);
    const item = await fetchItem(SESS_MAIN, itemId);
    expect(item.target_type).toBe('decision');

    const addId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m1-fetch-add' });
    expect((await fetchItem(SESS_MAIN, addId)).target_type).toBeNull();
  });

  it('SEC M-1: amend whose type differs from the target → review_required, nothing written', async () => {
    const memId = await insertTypedMemory('decision', 'promo-integ-m1-mismatch-mem');
    const itemId = await insertTypedAmend('gotcha', 'promo-integ-m1-mismatch-item', memId);
    const item = await fetchItem(SESS_MAIN, itemId);

    const result = await repo!.applyAccepted(item, mainCtx(), null, new Set());
    expect(result).toEqual({ status: 'review_required' });

    const { rows: mem } = await pool!.query(
      `SELECT type, current_revision, title FROM memory WHERE id = $1`, [memId],
    );
    expect(mem[0]).toMatchObject({ type: 'decision', current_revision: 1, title: 'Typed seed memory' });
    const { rows: st } = await pool!.query(
      `SELECT promoted_at FROM staging_item WHERE id = $1`, [itemId],
    );
    expect(st[0].promoted_at).toBeNull();
  });

  it('SEC M-1: amend of a mandatory target type → review_required even when types match', async () => {
    const memId = await insertTypedMemory('decision', 'promo-integ-m1-mandatory-mem');
    const itemId = await insertTypedAmend('decision', 'promo-integ-m1-mandatory-item', memId);
    const item = await fetchItem(SESS_MAIN, itemId);

    const result = await repo!.applyAccepted(item, mainCtx(), null, new Set(['decision']));
    expect(result).toEqual({ status: 'review_required' });
    const { rows: mem } = await pool!.query(`SELECT current_revision FROM memory WHERE id = $1`, [memId]);
    expect(mem[0].current_revision).toBe(1);
  });

  it('SEC M-3: quarantineItem on an applied or reviewed item writes nothing (no orphan row)', async () => {
    const appliedId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m3-applied' });
    const applied = await fetchItem(SESS_MAIN, appliedId);
    expect((await repo!.applyAccepted(applied, mainCtx(), null, new Set())).status).toBe('applied');

    const reviewedId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m3-reviewed' });
    const reviewed = await fetchItem(SESS_MAIN, reviewedId);
    await pool!.query(`UPDATE staging_item SET reviewed_at = now() WHERE id = $1`, [reviewedId]);

    for (const item of [applied, reviewed]) {
      await repo!.quarantineItem(item, mainCtx(), {
        reason: 'specificity', redact: false, decision: null, sanitizeFlags: {},
      });
    }

    const { rows: q } = await pool!.query(
      `SELECT count(*)::int AS n FROM quarantine WHERE origin_item_id = ANY($1::uuid[])`,
      [[appliedId, reviewedId]],
    );
    expect(q[0].n).toBe(0);
    const { rows: st } = await pool!.query(
      `SELECT id, judge_state FROM staging_item WHERE id = ANY($1::uuid[])`, [[appliedId, reviewedId]],
    );
    expect(st).toHaveLength(2);
    for (const r of st) expect(r.judge_state).not.toBe('rejected');
  });

  it('SEC M-3: recordDecision does not touch a reviewed item', async () => {
    const itemId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m3-record' });
    await pool!.query(`UPDATE staging_item SET reviewed_at = now() WHERE id = $1`, [itemId]);
    await repo!.recordDecision(itemId, {
      verdict: 'uncertain', criterion: 'confidence', confidence: 0.1,
      reason: 'late', relatedMemoryId: null, mandatoryReview: true,
    }, {});
    const { rows } = await pool!.query(
      `SELECT judge_state, judge_reason FROM staging_item WHERE id = $1`, [itemId],
    );
    expect(rows[0]).toEqual({ judge_state: 'pending', judge_reason: null });
  });

  it('Reviewer M1: R3/R4 keep the judge justification on staging; quarantine keeps the code', async () => {
    const itemId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m1r-just' });
    const item = await fetchItem(SESS_MAIN, itemId);
    await repo!.quarantineItem(item, mainCtx(), {
      reason: 'specificity',
      redact: false,
      decision: {
        verdict: 'rejected', criterion: 'specificity', confidence: 0.9,
        reason: 'Too generic: no file, module or concrete behaviour named.',
        relatedMemoryId: null, mandatoryReview: false,
      },
      sanitizeFlags: {},
    });
    const { rows: st } = await pool!.query(`SELECT judge_reason FROM staging_item WHERE id = $1`, [itemId]);
    expect(st[0].judge_reason).toBe('Too generic: no file, module or concrete behaviour named.');
    const { rows: q } = await pool!.query(`SELECT judge_reason FROM quarantine WHERE origin_item_id = $1`, [itemId]);
    expect(q[0].judge_reason).toBe('specificity');
  });

  it('Reviewer M1: a redacted judge quarantine keeps the constant on staging', async () => {
    const itemId = await insertAddItem({ sessionId: SESS_MAIN, contentHash: 'promo-integ-m1r-redact' });
    const item = await fetchItem(SESS_MAIN, itemId);
    await repo!.quarantineItem(item, mainCtx(), {
      reason: 'security_second_layer',
      redact: true,
      decision: {
        verdict: 'rejected', criterion: 'security_second_layer', confidence: 0.9,
        reason: 'security_second_layer', relatedMemoryId: null, mandatoryReview: false,
      },
      sanitizeFlags: { leak: true },
    });
    const { rows: st } = await pool!.query(`SELECT judge_reason FROM staging_item WHERE id = $1`, [itemId]);
    expect(st[0].judge_reason).toBe('security_second_layer');
  });

  it('SEC L-7: a redacted quarantine row stores the hash of the redacted content', async () => {
    const itemId = await insertAddItem({
      sessionId: SESS_MAIN,
      contentHash: 'promo-integ-l7-original-hash',
      body: 'Body with AKIAIOSFODNN7EXAMPLE inside.',
    });
    const item = await fetchItem(SESS_MAIN, itemId);
    await repo!.quarantineItem(item, mainCtx(), {
      reason: 'secret_detected', redact: true, decision: null,
      sanitizeFlags: { leak: true, secrets: ['aws_access_key_id'] },
    });
    const sentinel = '[REDACTED: secret detected]';
    const expected = computeContentHash({
      op: 'add', type: 'pattern', title: sentinel, summary: sentinel, body: sentinel,
      fields: {}, target: null,
    });
    const { rows: q } = await pool!.query(`SELECT content_hash FROM quarantine WHERE origin_item_id = $1`, [itemId]);
    expect(q[0].content_hash).toBe(expected);
    expect(q[0].content_hash).not.toBe('promo-integ-l7-original-hash');
  });

  it('Reviewer M2: after hash_conflict the quarantined staging row holds the masked text', async () => {
    const SESS_M2 = 'promo-integ-m2-hash-conflict-01';
    const BRANCH_M2 = 'm2-hash-conflict-branch';
    await pool!.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by)
       VALUES ($1, $2, $3, $4, 'integ-test-user') ON CONFLICT DO NOTHING`,
      [SESS_M2, projectId, repoId, BRANCH_M2],
    );
    const summary = 'Masking makes this item collide with its sibling.';
    const body = 'Body for the reviewer M2 hash-conflict regression in src/promote.';
    const maskedTitle = 'Owner [EMAIL] m2';
    // Sibling already holds the masked content under its canonical hash.
    const maskedHash = computeContentHash({
      op: 'add', type: 'pattern', title: maskedTitle, summary, body, fields: {}, target: null,
    });
    await insertAddItem({ sessionId: SESS_M2, contentHash: maskedHash, title: maskedTitle, summary, body });
    const rawId = await insertAddItem({
      sessionId: SESS_M2, contentHash: 'promo-integ-m2-raw',
      title: 'Owner jane.doe@example.com m2', summary, body,
    });

    const { PromoteService } = await import('../../src/promote/promoteService.js');
    const { FakeJudge, FakeAuditLogger, FakeNotifier, DEFAULT_ROUTING, META } =
      await import('../promote/fakes.js');
    const service = new PromoteService({
      promotionRepository: repo,
      judge: new FakeJudge(),
      auditLogger: new FakeAuditLogger(),
      embedder: { embed: () => Promise.reject(new Error('no embedder in this test')) },
      notifier: new FakeNotifier(),
      routing: DEFAULT_ROUTING,
    });
    await service.promote(SESS_M2, {
      ...META,
      tenant: { projectId, repoId, branch: BRANCH_M2 },
      originBranch: BRANCH_M2,
    });

    const { rows } = await pool!.query(
      `SELECT title, judge_state, judge_reason FROM staging_item WHERE id = $1`, [rawId],
    );
    expect(rows[0].judge_state).toBe('rejected');
    expect(rows[0].judge_reason).toBe('duplicate_content');
    expect(rows[0].title).toBe(maskedTitle);
    const { rows: q } = await pool!.query(`SELECT title FROM quarantine WHERE origin_item_id = $1`, [rawId]);
    expect(q[0].title).toBe(maskedTitle);
  });
});
