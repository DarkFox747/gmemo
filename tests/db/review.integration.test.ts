/**
 * PgPromotionRepository human review (approve / reject) — integration tests.
 *
 * SKIPPED when DATABASE_URL is not set. Exercises approveReviewItem and
 * rejectReviewItem end to end against a migrated Postgres:
 *  - approve reuses the promotion apply SQL (add / amend / deprecate / dedup),
 *    records approved_by + review columns and never touches judge_state;
 *  - markRelatedSuperseded (memory_relation source 'human');
 *  - stale target: applied only when the caller echoes the current revision;
 *  - conflicts: target_changed / target_inactive / duplicate_content (nothing written);
 *  - queue predicate: other project, abandoned session, resolved item → not_found;
 *  - reject quarantines with 'human_review: <reason>';
 *  - first writer wins under concurrent approve / reject / abandon.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type {
  PgPromotionRepository,
  ReviewApproveInput,
} from '../../src/db/promotionRepository.js';
import { EMBEDDING_DIM } from '../../src/embedder/embedder.js';
import { logger } from '../../src/observability/logger.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG_A = 'review-integ-a';
const SLUG_B = 'review-integ-b';

describeWithDb('PgPromotionRepository human review integration', () => {
  let pool: pg.Pool;
  let repo: PgPromotionRepository;
  let projectId: string;
  let otherProjectId: string;
  let repoId: string;
  let otherRepoId: string;
  let tlUserId: string;
  let sessionId: string;
  let branchSeq = 0;
  let hashSeq = 0;

  const hash = (tag: string) => `review-integ-${tag}-${++hashSeq}`;

  async function newSession(
    pid = projectId,
    rid = repoId,
    status: 'open' | 'abandoned' | 'promoted' = 'open',
  ): Promise<string> {
    const id = `review-integ-sess-${++branchSeq}`;
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, status, pr_number)
       VALUES ($1, $2, $3, $4, 'integ', $5::staging_status, 12)`,
      [id, pid, rid, `review-branch-${branchSeq}`, status],
    );
    return id;
  }

  async function insertMemory(
    p: {
      type?: string;
      contentHash?: string;
      status?: 'active' | 'superseded' | 'deprecated';
      pid?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body,
                           status, provenance, author_identity, content_hash)
       VALUES ($1, $2, $3, 'Seed memory title', 'Seed memory summary.', 'Seed memory body.',
               $4::memory_status, 'pr_reviewed', 'seed-user', $5)
       RETURNING id`,
      [
        p.pid ?? projectId,
        p.pid ? otherRepoId : repoId,
        p.type ?? 'pattern',
        p.status ?? 'active',
        p.contentHash ?? hash('mem'),
      ],
    );
    return rows[0].id as string;
  }

  async function insertItem(
    p: {
      session?: string;
      op?: 'add' | 'amend' | 'supersede' | 'deprecate';
      type?: string;
      contentHash?: string;
      target?: string | null;
      targetRevision?: number | null;
      judgeState?: 'pending' | 'accepted' | 'uncertain' | 'rejected';
      mandatory?: boolean;
      related?: string | null;
      title?: string;
    } = {},
  ): Promise<string> {
    const op = p.op ?? 'add';
    const { rows } = await pool.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash,
          target_memory_id, target_revision, author_identity,
          judge_state, judge_criterion, judge_confidence, mandatory_review, related_memory_id)
       VALUES ($1, $2, $3, $4, 'Review item summary.', 'Review item body with detail.', $5,
               $6, $7, 'demo-tl-review', $8::judge_state, 'confidence', 0.5, $9, $10)
       RETURNING id`,
      [
        p.session ?? sessionId,
        op,
        p.type ?? 'pattern',
        p.title ?? 'Review item title',
        p.contentHash ?? hash('item'),
        op === 'add' ? null : (p.target ?? null),
        op === 'add' ? null : (p.targetRevision ?? 1),
        p.judgeState ?? 'uncertain',
        p.mandatory ?? false,
        p.related ?? null,
      ],
    );
    return rows[0].id as string;
  }

  function input(itemId: string, overrides: Partial<ReviewApproveInput> = {}): ReviewApproveInput {
    return {
      projectId,
      itemId,
      reviewerUserId: tlUserId,
      expectedContentHash: '',
      embedding: null,
      targetRevision: null,
      markRelatedSuperseded: false,
      ...overrides,
    };
  }

  async function itemRow(id: string) {
    const { rows } = await pool.query(
      `SELECT promoted_at, promoted_memory_id, judge_state, review_decision, review_reason,
              reviewed_by, reviewed_at, target_revision, content_hash
         FROM staging_item WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgPromotionRepository: Repo } = await import('../../src/db/promotionRepository.js');
    repo = new Repo(pool, { quarantineRetentionDays: 60, revalidationDays: 60 });

    const proj = async (slug: string) => {
      const { rows } = await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, $1)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [slug],
      );
      const pid = rows[0].id as string;
      const { rows: r } = await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
         ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
        [pid, `https://github.com/test/${slug}`],
      );
      return { pid, rid: r[0].id as string };
    };
    ({ pid: projectId, rid: repoId } = await proj(SLUG_A));
    ({ pid: otherProjectId, rid: otherRepoId } = await proj(SLUG_B));

    const { rows: u } = await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name)
       VALUES ('demo-tl-review', 'tl-review@demo.local', 'TL review')
       ON CONFLICT (idp_subject) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    );
    tlUserId = u[0].id as string;
    sessionId = await newSession();
  });

  afterAll(async () => {
    if (!pool) return;
    for (const slug of [SLUG_A, SLUG_B]) {
      await pool.query(
        `DELETE FROM staging_item WHERE session_id IN
           (SELECT s.id FROM staging_session s JOIN project p ON p.id = s.project_id WHERE p.slug = $1)`,
        [slug],
      );
      await pool.query(`DELETE FROM project WHERE slug = $1`, [slug]);
    }
    await pool.query(`DELETE FROM app_user WHERE idp_subject = 'demo-tl-review'`);
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Approve — same apply path as promotion
  // -------------------------------------------------------------------------

  it('approves a queued add: memory r1, approved_by, review columns, judge_state unchanged', async () => {
    const itemId = await insertItem();
    const r = await repo.approveReviewItem(input(itemId));
    expect(r).toMatchObject({
      status: 'approved',
      deduped: false,
      rebasedFromRevision: null,
      rebasedToRevision: null,
      relatedSuperseded: false,
    });
    if (r.status !== 'approved') return;

    const { rows: mem } = await pool.query(
      `SELECT status, current_revision, provenance, approved_by, origin_branch, origin_pr
         FROM memory WHERE id = $1`,
      [r.memoryId],
    );
    expect(mem[0]).toMatchObject({
      status: 'active',
      current_revision: 1,
      provenance: 'pr_reviewed',
      approved_by: tlUserId,
      origin_pr: 12,
    });
    const { rows: rev } = await pool.query(
      `SELECT revision_no, op, promoted_from_item FROM memory_revision WHERE memory_id = $1`,
      [r.memoryId],
    );
    expect(rev).toEqual([{ revision_no: 1, op: 'add', promoted_from_item: itemId }]);
    // C4: approve goes through the shared apply core, so it sets the deadline too.
    const { rows: due } = await pool.query(
      `SELECT revalidate_at > now() + interval '59 days' AS ok FROM memory WHERE id = $1`,
      [r.memoryId],
    );
    expect(due[0].ok).toBe(true);

    const st = await itemRow(itemId);
    expect(st.promoted_at).not.toBeNull();
    expect(st.promoted_memory_id).toBe(r.memoryId);
    expect(st.review_decision).toBe('approved');
    expect(st.reviewed_by).toBe(tlUserId);
    expect(st.reviewed_at).not.toBeNull();
    expect(st.judge_state).toBe('uncertain');

    // Left the queue: a second approve is a not_found and changes nothing.
    expect(await repo.approveReviewItem(input(itemId))).toEqual({ status: 'not_found' });
    expect(
      await repo.rejectReviewItem({ projectId, itemId, reviewerUserId: tlUserId, reason: 'late' }),
    ).toBe('not_found');
  });

  it('approves a mandatory accepted decision', async () => {
    const itemId = await insertItem({ type: 'decision', judgeState: 'accepted', mandatory: true });
    const r = await repo.approveReviewItem(input(itemId));
    expect(r.status).toBe('approved');
    expect((await itemRow(itemId)).judge_state).toBe('accepted');
  });

  it('approves an uncertain amend → revision +1', async () => {
    const memId = await insertMemory();
    const itemId = await insertItem({ op: 'amend', target: memId, targetRevision: 1 });
    const r = await repo.approveReviewItem(input(itemId));
    expect(r).toMatchObject({ status: 'approved', memoryId: memId, deduped: false });
    const { rows } = await pool.query(
      `SELECT current_revision, title, approved_by FROM memory WHERE id = $1`,
      [memId],
    );
    expect(rows[0]).toEqual({
      current_revision: 2,
      title: 'Review item title',
      approved_by: tlUserId,
    });
    const { rows: rev } = await pool.query(
      `SELECT op FROM memory_revision WHERE memory_id = $1 AND revision_no = 2`,
      [memId],
    );
    expect(rev[0].op).toBe('amend');
  });

  it('approves a mandatory-type amend (the human is the gate; SEC M-1 only blocks the judge path)', async () => {
    const memId = await insertMemory({ type: 'decision' });
    const itemId = await insertItem({
      op: 'amend',
      type: 'decision',
      target: memId,
      mandatory: true,
    });
    const r = await repo.approveReviewItem(input(itemId));
    expect(r.status).toBe('approved');
  });

  it('approves a deprecate', async () => {
    const memId = await insertMemory();
    const itemId = await insertItem({ op: 'deprecate', target: memId });
    const r = await repo.approveReviewItem(input(itemId));
    expect(r).toMatchObject({ status: 'approved', memoryId: memId });
    const { rows } = await pool.query(`SELECT status, current_revision FROM memory WHERE id = $1`, [
      memId,
    ]);
    expect(rows[0]).toEqual({ status: 'deprecated', current_revision: 2 });
  });

  it('dedup add → deduped:true and the existing approver is untouched', async () => {
    const h = hash('dedup');
    const existing = await insertMemory({ contentHash: h });
    const itemId = await insertItem({ contentHash: h });
    const r = await repo.approveReviewItem(input(itemId));
    expect(r).toMatchObject({ status: 'approved', memoryId: existing, deduped: true });
    const { rows } = await pool.query(`SELECT approved_by FROM memory WHERE id = $1`, [existing]);
    expect(rows[0].approved_by).toBeNull();
  });

  it('writes the embedding only when the content hash still matches', async () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) / 7);
    const h1 = hash('emb-ok');
    const ok = await insertItem({ contentHash: h1 });
    const r1 = await repo.approveReviewItem(input(ok, { embedding: vec, expectedContentHash: h1 }));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const changed = await insertItem({ contentHash: hash('emb-changed') });
    const r2 = await repo.approveReviewItem(
      input(changed, { embedding: vec, expectedContentHash: 'stale-hash' }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    if (r1.status !== 'approved' || r2.status !== 'approved') throw new Error('expected approvals');
    const { rows } = await pool.query(
      `SELECT id, embedding IS NULL AS no_emb FROM memory WHERE id = ANY($1::uuid[])`,
      [[r1.memoryId, r2.memoryId]],
    );
    const byId = new Map(rows.map((x) => [x.id, x.no_emb]));
    expect(byId.get(r1.memoryId)).toBe(false);
    expect(byId.get(r2.memoryId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // markRelatedSuperseded
  // -------------------------------------------------------------------------

  it('markRelatedSuperseded supersedes the related active memory with a human relation', async () => {
    const related = await insertMemory({ type: 'decision' });
    const itemId = await insertItem({ type: 'decision', related });
    const r = await repo.approveReviewItem(input(itemId, { markRelatedSuperseded: true }));
    expect(r).toMatchObject({ status: 'approved', relatedSuperseded: true });
    if (r.status !== 'approved') return;
    const { rows } = await pool.query(
      `SELECT status FROM memory WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[related]],
    );
    expect(rows[0].status).toBe('superseded');
    const { rows: m } = await pool.query(`SELECT status FROM memory WHERE id = $1`, [r.memoryId]);
    expect(m[0].status).toBe('active');
    const { rows: rel } = await pool.query(
      `SELECT relation_type, source FROM memory_relation WHERE from_memory = $1 AND to_memory = $2`,
      [r.memoryId, related],
    );
    expect(rel).toEqual([{ relation_type: 'supersedes', source: 'human' }]);
  });

  it('markRelatedSuperseded reports false when it cannot apply', async () => {
    const already = await insertMemory({ status: 'superseded' });
    const a = await insertItem({ related: already });
    expect(await repo.approveReviewItem(input(a, { markRelatedSuperseded: true }))).toMatchObject({
      status: 'approved',
      relatedSuperseded: false,
    });

    const none = await insertItem();
    expect(
      await repo.approveReviewItem(input(none, { markRelatedSuperseded: true })),
    ).toMatchObject({ status: 'approved', relatedSuperseded: false });

    const target = await insertMemory();
    const related = await insertMemory();
    const dep = await insertItem({ op: 'deprecate', target, related });
    expect(await repo.approveReviewItem(input(dep, { markRelatedSuperseded: true }))).toMatchObject(
      { status: 'approved', relatedSuperseded: false },
    );
    const { rows } = await pool.query(`SELECT status FROM memory WHERE id = $1`, [related]);
    expect(rows[0].status).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Stale target and conflicts
  // -------------------------------------------------------------------------

  it('stale target: conflict unless the caller confirms the current revision, then rebases', async () => {
    const memId = await insertMemory();
    const itemId = await insertItem({
      op: 'amend',
      target: memId,
      targetRevision: 1,
      mandatory: true,
    });
    await pool.query(`UPDATE memory SET current_revision = 2 WHERE id = $1`, [memId]);

    expect(await repo.approveReviewItem(input(itemId))).toEqual({
      status: 'conflict',
      code: 'target_changed',
    });
    expect(await repo.approveReviewItem(input(itemId, { targetRevision: 1 }))).toEqual({
      status: 'conflict',
      code: 'target_changed',
    });
    let st = await itemRow(itemId);
    expect(st.reviewed_at).toBeNull();
    expect(st.target_revision).toBe(1);

    const r = await repo.approveReviewItem(input(itemId, { targetRevision: 2 }));
    expect(r).toMatchObject({ status: 'approved', rebasedFromRevision: 1, rebasedToRevision: 2 });
    const { rows } = await pool.query(`SELECT current_revision FROM memory WHERE id = $1`, [memId]);
    expect(rows[0].current_revision).toBe(3);
    st = await itemRow(itemId);
    expect(st.target_revision).toBe(2);
  });

  it('a targetRevision that does not match the current revision is a conflict even when not stale', async () => {
    const memId = await insertMemory();
    const itemId = await insertItem({ op: 'amend', target: memId, targetRevision: 1 });
    expect(await repo.approveReviewItem(input(itemId, { targetRevision: 5 }))).toEqual({
      status: 'conflict',
      code: 'target_changed',
    });
  });

  it('target deprecated → target_inactive, item stays queued', async () => {
    const memId = await insertMemory({ status: 'deprecated' });
    const itemId = await insertItem({ op: 'amend', target: memId });
    expect(await repo.approveReviewItem(input(itemId))).toEqual({
      status: 'conflict',
      code: 'target_inactive',
    });
    expect((await itemRow(itemId)).reviewed_at).toBeNull();
  });

  it('target type differs from the item type → target_inactive, nothing written (SEC M-1)', async () => {
    const memId = await insertMemory({ type: 'decision' });
    const itemId = await insertItem({
      op: 'amend',
      type: 'gotcha',
      target: memId,
      mandatory: true,
    });
    expect(await repo.approveReviewItem(input(itemId))).toEqual({
      status: 'conflict',
      code: 'target_inactive',
    });
    const { rows } = await pool.query(`SELECT type, current_revision FROM memory WHERE id = $1`, [
      memId,
    ]);
    expect(rows[0]).toEqual({ type: 'decision', current_revision: 1 });
    expect((await itemRow(itemId)).promoted_at).toBeNull();
  });

  it('amend colliding with another memory → duplicate_content, rolled back, item queued', async () => {
    const h = hash('dup-amend');
    await insertMemory({ contentHash: h });
    const memId = await insertMemory();
    const itemId = await insertItem({ op: 'amend', target: memId, contentHash: h });
    expect(await repo.approveReviewItem(input(itemId))).toEqual({
      status: 'conflict',
      code: 'duplicate_content',
    });
    const { rows } = await pool.query(`SELECT current_revision FROM memory WHERE id = $1`, [memId]);
    expect(rows[0].current_revision).toBe(1);
    const st = await itemRow(itemId);
    expect(st.reviewed_at).toBeNull();
    expect(st.promoted_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Queue predicate
  // -------------------------------------------------------------------------

  it('items outside the queue are not_found (other project, abandoned session, rejected, pending)', async () => {
    const foreign = await insertItem({ session: await newSession(otherProjectId, otherRepoId) });
    const abandoned = await insertItem({
      session: await newSession(projectId, repoId, 'abandoned'),
    });
    const rejected = await insertItem({ judgeState: 'rejected' });
    const pending = await insertItem({ judgeState: 'pending' });
    for (const id of [foreign, abandoned, rejected, pending]) {
      expect(await repo.approveReviewItem(input(id))).toEqual({ status: 'not_found' });
      expect(
        await repo.rejectReviewItem({
          projectId,
          itemId: id,
          reviewerUserId: tlUserId,
          reason: 'nope',
        }),
      ).toBe('not_found');
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM quarantine WHERE origin_item_id = ANY($1::uuid[])`,
      [[foreign, abandoned, rejected, pending]],
    );
    expect(rows[0].n).toBe(0);
  });

  it('a finalized (promoted) session still serves its queued items', async () => {
    const itemId = await insertItem({ session: await newSession(projectId, repoId, 'promoted') });
    expect((await repo.approveReviewItem(input(itemId))).status).toBe('approved');
  });

  // -------------------------------------------------------------------------
  // Reject
  // -------------------------------------------------------------------------

  it('reject quarantines with human_review reason and records the review columns', async () => {
    const itemId = await insertItem({ mandatory: true });
    expect(
      await repo.rejectReviewItem({
        projectId,
        itemId,
        reviewerUserId: tlUserId,
        reason: 'too vague',
      }),
    ).toBe('rejected');
    const { rows: q } = await pool.query(
      `SELECT judge_reason, project_id, origin_session_id, title, criterion, reason_code
         FROM quarantine WHERE origin_item_id = $1`,
      [itemId],
    );
    expect(q).toEqual([
      {
        judge_reason: 'human_review: too vague',
        project_id: projectId,
        origin_session_id: sessionId,
        title: 'Review item title',
        criterion: 'human_review',
        reason_code: 'human_rejected',
      },
    ]);
    const st = await itemRow(itemId);
    expect(st).toMatchObject({
      review_decision: 'rejected',
      review_reason: 'too vague',
      reviewed_by: tlUserId,
      judge_state: 'uncertain',
      promoted_at: null,
    });
    expect(st.reviewed_at).not.toBeNull();
    expect(
      await repo.rejectReviewItem({ projectId, itemId, reviewerUserId: tlUserId, reason: 'again' }),
    ).toBe('not_found');
  });

  // -------------------------------------------------------------------------
  // Concurrency (real row locks)
  // -------------------------------------------------------------------------

  it('approve vs reject in parallel → exactly one wins', async () => {
    const itemId = await insertItem();
    const [a, rj] = await Promise.all([
      repo.approveReviewItem(input(itemId)),
      repo.rejectReviewItem({ projectId, itemId, reviewerUserId: tlUserId, reason: 'race' }),
    ]);
    const approved = a.status === 'approved';
    const rejected = rj === 'rejected';
    expect(approved !== rejected).toBe(true);
    const { rows: q } = await pool.query(
      `SELECT count(*)::int AS n FROM quarantine WHERE origin_item_id = $1`,
      [itemId],
    );
    const { rows: rev } = await pool.query(
      `SELECT count(*)::int AS n FROM memory_revision WHERE promoted_from_item = $1`,
      [itemId],
    );
    expect(q[0].n + rev[0].n).toBe(1);
  });

  it('abandon racing approve: an approved row survives the delete', async () => {
    const sess = await newSession();
    const itemId = await insertItem({ session: sess });
    const other = await insertItem({ session: sess });
    const [a, ab] = await Promise.all([
      repo.approveReviewItem(input(itemId)),
      repo.abandonOpenSession(sess, projectId),
    ]);
    expect(ab.abandoned).toBe(true);
    const { rows } = await pool.query(`SELECT id FROM staging_item WHERE id = ANY($1::uuid[])`, [
      [itemId, other],
    ]);
    const left = rows.map((x) => x.id);
    expect(left).not.toContain(other);
    if (a.status === 'approved') expect(left).toEqual([itemId]);
    else expect(left).toEqual([]);
  });
});
