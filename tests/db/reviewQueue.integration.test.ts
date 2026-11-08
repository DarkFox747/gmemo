/**
 * PgReviewQueueRepository — integration tests (real SQL).
 *
 * SKIPPED when DATABASE_URL is not set. Seeds the spec "Counters" scenario:
 * 3 uncertain + 2 mandatory queued items and 4 items reviewed in the last
 * 7 days, plus noise that must never count (reviewed 8 days ago, another
 * project, an abandoned session, promoted / judge-rejected / pending rows).
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgReviewQueueRepository } from '../../src/db/reviewQueueRepository.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG_A = 'review-queue-integ-a';
const SLUG_B = 'review-queue-integ-b';

describeWithDb('PgReviewQueueRepository integration', () => {
  let pool: pg.Pool;
  let repo: PgReviewQueueRepository;
  let projectId: string;
  let otherProjectId: string;
  let repoId: string;
  let otherRepoId: string;
  let sessionId: string;
  let abandonedSessionId: string;
  let otherSessionId: string;
  let seq = 0;

  // Named items of project A (ids filled in beforeAll).
  const ids: Record<string, string> = {};
  let relatedMemoryId: string;
  let targetMemoryId: string;
  let foreignMemoryId: string;

  async function insertItem(p: {
    session?: string;
    type?: string;
    judgeState?: 'pending' | 'accepted' | 'uncertain' | 'rejected';
    mandatory?: boolean;
    minutesAgo: number;
    reviewedDaysAgo?: number;
    promoted?: boolean;
    author?: string;
    op?: 'add' | 'amend';
    target?: string;
    related?: string | null;
  }): Promise<string> {
    const op = p.op ?? 'add';
    const { rows } = await pool.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, fields, content_hash, author_identity,
          target_memory_id, target_revision,
          judge_state, judge_reason, judge_criterion, judge_confidence, mandatory_review,
          related_memory_id, sanitize_flags, created_at, reviewed_at, promoted_at)
       VALUES ($1, $2, $3, $4, 'Queue item summary.', 'Queue item body.', '{"k":"v"}'::jsonb, $5, $6,
               $7, $8,
               $9::judge_state, 'judge says maybe', 'confidence', 0.6, $10,
               $11, '{"pii":["email"]}'::jsonb,
               now() - make_interval(mins => $12::int),
               CASE WHEN $13::int IS NULL THEN NULL ELSE now() - make_interval(days => $13::int) END,
               CASE WHEN $14::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [
        p.session ?? sessionId,
        op,
        p.type ?? 'pattern',
        `Queue item ${++seq}`,
        `review-queue-integ-${seq}`,
        p.author ?? 'unknown-author',
        op === 'add' ? null : p.target,
        op === 'add' ? null : 1,
        p.judgeState ?? 'uncertain',
        p.mandatory ?? false,
        p.related ?? null,
        p.minutesAgo,
        p.reviewedDaysAgo ?? null,
        p.promoted ?? false,
      ],
    );
    return rows[0].id as string;
  }

  async function insertMemory(pid: string, rid: string, tag: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, origin_branch, origin_pr)
       VALUES ($1, $2, 'decision', $3, 'Ref summary.', 'Ref body.', 'active', 'pr_reviewed',
               'seed', $3, 'feature/ref', 9)
       RETURNING id`,
      [pid, rid, `review-queue-ref-${tag}`],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgReviewQueueRepository: Repo } = await import('../../src/db/reviewQueueRepository.js');
    repo = new Repo(pool);

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

    await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name)
       VALUES ('review-queue-author', 'rq-author@demo.local', 'Queue Author')
       ON CONFLICT (idp_subject) DO NOTHING`,
    );

    const session = async (
      id: string,
      pid: string,
      rid: string,
      branch: string,
      status: string,
    ) => {
      await pool.query(
        `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, status, pr_number)
         VALUES ($1, $2, $3, $4, 'integ', $5::staging_status, 7)`,
        [id, pid, rid, branch, status],
      );
      return id;
    };
    sessionId = await session('rq-integ-open', projectId, repoId, 'feature/queue', 'open');
    abandonedSessionId = await session(
      'rq-integ-abandoned',
      projectId,
      repoId,
      'feature/gone',
      'abandoned',
    );
    otherSessionId = await session(
      'rq-integ-other',
      otherProjectId,
      otherRepoId,
      'feature/other',
      'open',
    );

    relatedMemoryId = await insertMemory(projectId, repoId, 'related');
    targetMemoryId = await insertMemory(projectId, repoId, 'target');
    foreignMemoryId = await insertMemory(otherProjectId, otherRepoId, 'foreign');

    // Queued: 3 uncertain (not mandatory) + 2 mandatory.
    ids.u1 = await insertItem({
      minutesAgo: 50,
      author: 'review-queue-author',
      related: relatedMemoryId,
    });
    ids.u2 = await insertItem({ minutesAgo: 40, type: 'decision' });
    ids.u3 = await insertItem({ minutesAgo: 30 });
    ids.m1 = await insertItem({
      minutesAgo: 20,
      type: 'decision',
      judgeState: 'accepted',
      mandatory: true,
    });
    ids.m2 = await insertItem({
      minutesAgo: 10,
      mandatory: true,
      op: 'amend',
      target: targetMemoryId,
    });
    // Reviewed within 7 days (4) and 8 days ago (1).
    for (const d of [1, 2, 3, 6])
      ids[`r${d}`] = await insertItem({ minutesAgo: 60, reviewedDaysAgo: d });
    ids.old = await insertItem({ minutesAgo: 60, reviewedDaysAgo: 8 });
    // Noise.
    ids.abandoned = await insertItem({ session: abandonedSessionId, minutesAgo: 5 });
    ids.foreign = await insertItem({ session: otherSessionId, minutesAgo: 5 });
    ids.promoted = await insertItem({ minutesAgo: 5, promoted: true });
    ids.rejected = await insertItem({ minutesAgo: 5, judgeState: 'rejected', mandatory: true });
    ids.pending = await insertItem({ minutesAgo: 5, judgeState: 'pending' });
    ids.acceptedNotMandatory = await insertItem({ minutesAgo: 5, judgeState: 'accepted' });
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
    await pool.query(`DELETE FROM app_user WHERE idp_subject = 'review-queue-author'`);
    await pool.end();
  });

  it('counters: pending 5, uncertain 3, mandatory 2, resolved last 7 days 4', async () => {
    expect(await repo.countQueue(projectId)).toEqual({
      pending: 5,
      uncertain: 3,
      mandatory: 2,
      resolvedLast7Days: 4,
    });
  });

  it('counters are project-scoped', async () => {
    expect(await repo.countQueue(otherProjectId)).toEqual({
      pending: 1,
      uncertain: 1,
      mandatory: 0,
      resolvedLast7Days: 0,
    });
  });

  it('lists every queued item oldest first with filter=all', async () => {
    const { rows, truncated } = await repo.listQueue(projectId, {
      filter: 'all',
      type: null,
      limit: 100,
    });
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.id)).toEqual([ids.u1, ids.u2, ids.u3, ids.m1, ids.m2]);
    const first = rows[0]!;
    expect(first).toMatchObject({
      op: 'add',
      type: 'pattern',
      judge_state: 'uncertain',
      judge_criterion: 'confidence',
      mandatory_review: false,
      origin_branch: 'feature/queue',
      origin_pr: 7,
      author: 'Queue Author',
    });
    expect(first.judge_confidence).toBeCloseTo(0.6);
    expect(first.created_at).toBeInstanceOf(Date);
    expect(rows[1]!.author).toBe('unknown-author');
  });

  it('filters uncertain / mandatory / type', async () => {
    const u = await repo.listQueue(projectId, { filter: 'uncertain', type: null, limit: 100 });
    expect(u.rows.map((r) => r.id)).toEqual([ids.u1, ids.u2, ids.u3]);
    const m = await repo.listQueue(projectId, { filter: 'mandatory', type: null, limit: 100 });
    expect(m.rows.map((r) => r.id)).toEqual([ids.m1, ids.m2]);
    const d = await repo.listQueue(projectId, { filter: 'all', type: 'decision', limit: 100 });
    expect(d.rows.map((r) => r.id)).toEqual([ids.u2, ids.m1]);
    const ud = await repo.listQueue(projectId, {
      filter: 'uncertain',
      type: 'decision',
      limit: 100,
    });
    expect(ud.rows.map((r) => r.id)).toEqual([ids.u2]);
  });

  it('limit truncates and drops the extra row', async () => {
    const t = await repo.listQueue(projectId, { filter: 'all', type: null, limit: 2 });
    expect(t).toMatchObject({ truncated: true });
    expect(t.rows.map((r) => r.id)).toEqual([ids.u1, ids.u2]);
    const exact = await repo.listQueue(projectId, { filter: 'all', type: null, limit: 5 });
    expect(exact.truncated).toBe(false);
    expect(exact.rows).toHaveLength(5);
  });

  it('detail returns the full queued item', async () => {
    const d = await repo.findQueuedItem(projectId, ids.m2!);
    expect(d).toMatchObject({
      id: ids.m2,
      op: 'amend',
      summary: 'Queue item summary.',
      body: 'Queue item body.',
      fields: { k: 'v' },
      target_memory_id: targetMemoryId,
      target_revision: 1,
      judge_state: 'uncertain',
      judge_reason: 'judge says maybe',
      mandatory_review: true,
      sanitize_flags: { pii: ['email'] },
      origin_branch: 'feature/queue',
      origin_pr: 7,
      author: 'unknown-author',
      related_memory_id: null,
    });
    expect(d!.content_hash).toBeTruthy();
    expect((await repo.findQueuedItem(projectId, ids.u1!))!.related_memory_id).toBe(
      relatedMemoryId,
    );
  });

  it('detail is null for resolved, foreign, abandoned and non-queued items', async () => {
    for (const k of [
      'r1',
      'promoted',
      'rejected',
      'pending',
      'acceptedNotMandatory',
      'abandoned',
    ]) {
      expect(await repo.findQueuedItem(projectId, ids[k]!)).toBeNull();
    }
    expect(await repo.findQueuedItem(projectId, ids.foreign!)).toBeNull();
    expect(await repo.findQueuedItem(otherProjectId, ids.u1!)).toBeNull();
  });

  it('memory refs are project-scoped; [] makes no query', async () => {
    expect(await repo.findMemoryRefs(projectId, [])).toEqual([]);
    const refs = await repo.findMemoryRefs(projectId, [
      relatedMemoryId,
      targetMemoryId,
      foreignMemoryId,
    ]);
    expect(refs.map((r) => r.id).sort()).toEqual([relatedMemoryId, targetMemoryId].sort());
    const ref = refs.find((r) => r.id === relatedMemoryId)!;
    expect(ref).toMatchObject({
      type: 'decision',
      title: 'review-queue-ref-related',
      summary: 'Ref summary.',
      status: 'active',
      current_revision: 1,
      origin_branch: 'feature/ref',
      origin_pr: 9,
    });
    expect(ref.updated_at).toBeInstanceOf(Date);
  });
});
