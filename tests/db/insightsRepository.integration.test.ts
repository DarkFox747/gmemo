/**
 * PgInsightsRepository integration tests (C12). SKIPPED without DATABASE_URL.
 *
 * Dashboard: every label combination of the spec scenario (FP 3/8, FN 1/3),
 * exclusions (restore/ and web/ sessions, stale_target, judge_unavailable,
 * labels outside the window, other projects), outcome buckets and the queue
 * counters equal to the review queue's. Activity: reads excluded, actor
 * rendering, project-scoped targets, job rows scoped to the project, keyset
 * pagination, category filter, no hash/identity/merge SHA in the output.
 * Staging: open vs closed window, reserved sessions excluded, item states,
 * PII-masked titles, 100-item cap and session limit.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PgInsightsRepository as Repo } from '../../src/db/insightsRepository.js';
import type { RequestContext } from '../../src/mcp/context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'insights-integ';
const SLUGS = ['dash', 'dashq', 'act', 'actf', 'page', 'stg', 'edge'].map((s) => `${PREFIX}-${s}`);

describeWithDb('PgInsightsRepository integration', () => {
  let pool: pg.Pool;
  let repo: Repo;
  let seq = 0;
  const P: Record<string, { pid: string; rid: string }> = {};

  async function project(key: string): Promise<{ pid: string; rid: string }> {
    const slug = `${PREFIX}-${key}`;
    const { rows } = await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, $1) RETURNING id`,
      [slug],
    );
    const pid = rows[0].id as string;
    const { rows: r } = await pool.query(
      `INSERT INTO repo (project_id, remote_url, slug) VALUES ($1, $2, $3) RETURNING id`,
      [pid, `https://github.com/${PREFIX}/${key}`, `${PREFIX}/${key}`],
    );
    return { pid, rid: r[0].id as string };
  }

  async function session(
    key: string,
    branch: string,
    p: {
      status?: string;
      promotedDaysAgo?: number;
      lastActivityDaysAgo?: number;
      openedBy?: string;
      pr?: number;
    } = {},
  ): Promise<string> {
    const id = `01INSIGHTS${String(++seq).padStart(16, '0')}`;
    await pool.query(
      `INSERT INTO staging_session
         (id, project_id, repo_id, branch, status, opened_by, pr_number, promoted_at,
          last_activity_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::staging_status, $6, $7,
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(days => $8::int) END,
               now() - make_interval(days => COALESCE($9::int, 0)),
               now() + interval '7 days')`,
      [
        id,
        P[key]!.pid,
        P[key]!.rid,
        branch,
        p.status ?? 'open',
        p.openedBy ?? `${PREFIX}-nobody`,
        p.pr ?? null,
        p.promotedDaysAgo ?? null,
        p.lastActivityDaysAgo ?? null,
      ],
    );
    return id;
  }

  async function item(
    sessionId: string,
    p: {
      state?: 'pending' | 'accepted' | 'uncertain' | 'rejected';
      criterion?: string | null;
      reason?: string | null;
      mandatory?: boolean;
      decision?: 'approved' | 'rejected';
      reviewedDaysAgo?: number;
      promoted?: boolean;
      title?: string;
      minutesAgo?: number;
    } = {},
  ): Promise<string> {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO staging_item
         (session_id, op, type, title, summary, body, content_hash, author_identity,
          judge_state, judge_criterion, judge_reason, mandatory_review,
          review_decision, reviewed_at, promoted_at, created_at)
       VALUES ($1, 'add', 'pattern', $2, 'Summary.', 'Body.', $3, 'author',
               $4::judge_state, $5, $6, $7,
               $8::review_decision,
               CASE WHEN $9::int IS NULL THEN NULL ELSE now() - make_interval(days => $9::int) END,
               CASE WHEN $10::boolean THEN now() ELSE NULL END,
               now() - make_interval(mins => $11::int))
       RETURNING id`,
      [
        sessionId,
        p.title ?? `Insights item ${n}`,
        `${PREFIX}-${n}`,
        p.state ?? 'pending',
        p.criterion ?? null,
        p.reason ?? null,
        p.mandatory ?? false,
        p.decision ?? null,
        p.decision ? (p.reviewedDaysAgo ?? 1) : null,
        p.promoted ?? false,
        p.minutesAgo ?? n,
      ],
    );
    return rows[0].id as string;
  }

  async function quarantine(
    key: string,
    criterion: 'pipeline' | 'judge' | 'human_review',
    p: { restoredDaysAgo?: number; originItem?: string; title?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO quarantine
         (project_id, repo_id, origin_item_id, op, type, title, summary, body, content_hash,
          judge_reason, author_identity, criterion, restored_at)
       VALUES ($1, $2, $3, 'add', 'gotcha', $4, 'S', 'B', 'qh', 'r', 'author',
               $5::quarantine_criterion,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)
       RETURNING id`,
      [
        P[key]!.pid,
        P[key]!.rid,
        p.originItem ?? null,
        p.title ?? `Quarantined ${++seq}`,
        criterion,
        p.restoredDaysAgo ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function memory(key: string, title: string, status = 'active', type = 'decision') {
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash)
       VALUES ($1, $2, $3::memory_type, $4, 'S', 'B', $5::memory_status, 'pr_reviewed', 'seed', $4)
       RETURNING id`,
      [P[key]!.pid, P[key]!.rid, type, title, status],
    );
    return rows[0].id as string;
  }

  async function user(subject: string, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO app_user (idp_subject, email, display_name)
       VALUES ($1, $1 || '@insights.test', $2)
       ON CONFLICT (idp_subject) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [subject, name],
    );
  }

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM staging_item WHERE session_id IN
         (SELECT id FROM staging_session WHERE project_id IN (SELECT id FROM project WHERE slug = ANY($1)))`,
      [SLUGS],
    );
    await pool.query(`DELETE FROM project WHERE slug = ANY($1)`, [SLUGS]);
    await pool.query(`DELETE FROM app_user WHERE idp_subject LIKE $1`, [`${PREFIX}-%`]);
  }

  // Activity fixture ids.
  const act: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    const { PgInsightsRepository } = await import('../../src/db/insightsRepository.js');
    repo = new PgInsightsRepository(pool);
    await cleanup();
    for (const key of ['dash', 'dashq', 'act', 'actf', 'page', 'stg', 'edge'])
      P[key] = await project(key);

    // --- Dashboard fixture (project dash; noise in dashq) ---
    await memory('dash', 'Mem one');
    await memory('dash', 'Mem two');
    await memory('dash', 'Mem three', 'active', 'pattern');
    await memory('dash', 'Mem retired', 'deprecated');
    await memory('dashq', 'Foreign mem');

    const prom = await session('dash', 'feature/judge', { status: 'promoted', promotedDaysAgo: 1 });
    for (let i = 0; i < 2; i++) {
      await item(prom, {
        state: 'uncertain',
        criterion: 'grounding',
        decision: 'approved',
        promoted: true,
      });
      await item(prom, { state: 'uncertain', criterion: 'grounding', decision: 'rejected' });
    }
    for (let i = 0; i < 5; i++) {
      await item(prom, {
        state: 'accepted',
        criterion: 'confidence',
        mandatory: true,
        decision: 'approved',
        promoted: true,
      });
    }
    await item(prom, {
      state: 'accepted',
      criterion: 'confidence',
      mandatory: true,
      decision: 'rejected',
    });
    const dup = await item(prom, { state: 'rejected', criterion: 'duplication' });
    const spec = await item(prom, { state: 'rejected', criterion: 'specificity' });
    const blocked = await item(prom, { state: 'rejected', criterion: null });
    await item(prom, { state: 'rejected', criterion: 'confidence' }); // dedup at apply
    await item(prom, { state: 'accepted', criterion: 'confidence', promoted: true });
    await item(prom, { state: 'accepted', criterion: 'confidence', promoted: true });
    // Excluded from labels (and counted as not evaluated):
    await item(prom, {
      state: 'uncertain',
      criterion: 'stale_target',
      mandatory: true,
      decision: 'approved',
      promoted: true,
    });
    await item(prom, {
      state: 'uncertain',
      criterion: 'confidence',
      reason: 'judge_unavailable',
      decision: 'approved',
      promoted: true,
    });
    // Label outside the window (still an outcome of this promotion).
    await item(prom, {
      state: 'uncertain',
      criterion: 'grounding',
      decision: 'approved',
      reviewedDaysAgo: 31,
      promoted: true,
    });

    const restoreSess = await session('dash', 'restore/abc', {
      status: 'promoted',
      promotedDaysAgo: 1,
    });
    await item(restoreSess, {
      state: 'uncertain',
      criterion: 'grounding',
      decision: 'approved',
      promoted: true,
    });
    const webSess = await session('dash', 'web/u/1', { status: 'promoted', promotedDaysAgo: 1 });
    await item(webSess, {
      state: 'accepted',
      criterion: 'confidence',
      mandatory: true,
      decision: 'approved',
      promoted: true,
    });
    const foreign = await session('dashq', 'feature/q', { status: 'promoted', promotedDaysAgo: 1 });
    await item(foreign, {
      state: 'uncertain',
      criterion: 'grounding',
      decision: 'approved',
      promoted: true,
    });

    await quarantine('dash', 'judge', { restoredDaysAgo: 1, originItem: dup });
    await quarantine('dash', 'pipeline', { restoredDaysAgo: 1, originItem: blocked });
    await quarantine('dash', 'judge', { originItem: spec });
    await quarantine('dash', 'human_review');
    await quarantine('dash', 'judge', { restoredDaysAgo: 40 });
    await quarantine('dashq', 'judge', { restoredDaysAgo: 1 });

    const open = await session('dash', 'feature/open');
    for (let i = 0; i < 3; i++) await item(open, { state: 'uncertain', criterion: 'grounding' });
    for (let i = 0; i < 2; i++)
      await item(open, { state: 'accepted', criterion: 'confidence', mandatory: true });
    await item(open); // pending: not queued

    // --- Activity fixture (project act; foreign rows in actf) ---
    await user(`${PREFIX}-ana`, 'Ana');
    await user(`${PREFIX}-diego`, 'Diego');
    act.memory = await memory('act', 'Activity memory');
    act.foreignMemory = await memory('actf', 'Foreign memory');
    act.session = await session('act', 'feature/act', { pr: 12 });
    act.item = await item(act.session, { title: 'Contact bob@example.com' });
    const fSess = await session('actf', 'feature/f');
    act.foreignItem = await item(fSess, { title: 'Foreign item' });

    const { PgAuthRepository } = await import('../../src/db/authRepository.js');
    const { RdsAuditLogger } = await import('../../src/auth/auditLogger.js');
    const logger = new RdsAuditLogger(new PgAuthRepository(pool));
    const A = P.act!.pid;
    const B = P.actf!.pid;
    const diego = { actorId: `${PREFIX}-diego`, userId: 'u-diego', roles: [] };
    const anaCtx: RequestContext = {
      tenant: { projectId: A, repoId: P.act!.rid, branch: 'feature/act' },
      actor: { actorId: `${PREFIX}-ana`, userId: 'u-ana', roles: [] },
    };
    const ciCtx: RequestContext = {
      tenant: { projectId: A, repoId: P.act!.rid, branch: 'main' },
      actor: { actorId: 'repo:insights/act', userId: null, roles: [] },
    };

    await logger.recordApi(diego, { projectId: A }, 'memories.list', {
      resultCount: 3,
      queryHash: 'QHASHSECRET0000',
    });
    await logger.recordWrite(anaCtx, {
      tool: 'remember',
      sessionId: act.session,
      itemId: act.item,
      contentHash: 'CHASHSECRET0000',
    });
    await logger.recordPromote(ciCtx, {
      sessionId: act.session,
      applied: 3,
      quarantined: 1,
      uncertain: 1,
      prNumber: 12,
      mergeSha: 'MERGESHASECRET00',
    });
    await logger.recordApi(diego, { projectId: A }, 'review_queue.approve', {
      itemId: act.item,
      memoryId: act.memory,
      decision: 'approved',
    });
    await logger.recordApi(diego, { projectId: A }, 'review_queue.approve', {
      itemId: act.foreignItem,
      memoryId: act.foreignMemory,
      decision: 'approved',
    });
    await logger.recordApi(diego, { projectId: A }, 'memory.retire', { memoryId: act.memory });
    await logger.recordJob({
      job: 'quarantine-purge',
      count: 5,
      detail: { [A]: 2, [B]: 3 },
      trigger: 'script',
    });
    await logger.recordJob({
      job: 'revalidation-sweep',
      count: 1,
      detail: { [B]: 1 },
      trigger: 'script',
    });
    await logger.recordApi(diego, { projectId: A }, 'review_queue.reject', {
      itemId: '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11',
      decision: 'rejected',
    });

    // --- Pagination fixture: 120 review events + reads ---
    await pool.query(
      `INSERT INTO access_log (actor_identity, actor_kind, action, project_id, detail)
       SELECT $2, 'user'::actor_kind, 'update'::access_action, $1, jsonb_build_object('api', 'review_queue.approve', 'n', g)
       FROM generate_series(1, 120) g`,
      [P.page!.pid, `${PREFIX}-diego`],
    );
    await pool.query(
      `INSERT INTO access_log (actor_identity, actor_kind, action, project_id, detail)
       SELECT $2, 'user'::actor_kind, 'read'::access_action, $1, '{"api":"memories.list"}'::jsonb FROM generate_series(1, 5)`,
      [P.page!.pid, `${PREFIX}-diego`],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  describe('getDashboard', () => {
    it('live indicators from stored labels: FP 3/8, FN 1/3', async () => {
      const d = await repo.getDashboard(P.dash!.pid);
      expect(d.windowDays).toBe(30);
      expect(d.judge.labels).toEqual({
        uncertainApproved: 2,
        uncertainRejected: 2,
        acceptedApproved: 5,
        acceptedRejected: 1,
        restoredFromJudge: 1,
      });
      expect(d.judge.falsePositive).toEqual({ count: 3, of: 8, rate: 0.375 });
      expect(d.judge.falseNegative).toEqual({ count: 1, of: 3, rate: 1 / 3 });
      expect(d.judge.restoredOther).toEqual({ pipeline: 1, humanReview: 0 });
    });

    it('outcome buckets and unlabelled coverage over the promoted agent session', async () => {
      const d = await repo.getDashboard(P.dash!.pid);
      expect(d.judge.outcomes).toEqual({
        accepted: 8,
        uncertain: 5,
        rejected: 2,
        pipelineBlocked: 2,
        notEvaluated: 2,
      });
      expect(d.judge.unlabeled).toEqual({ autoApplied: 2, judgeRejectedNotRestored: 1 });
    });

    it('memories, quarantine and queue counts (queue equals the review queue counters)', async () => {
      const d = await repo.getDashboard(P.dash!.pid);
      expect(d.memories.total).toBe(4);
      expect(d.memories.byStatus).toEqual({
        active: 3,
        pending_revalidation: 0,
        superseded: 0,
        deprecated: 1,
      });
      expect(d.memories.activeByType.decision).toBe(2);
      expect(d.memories.activeByType.pattern).toBe(1);
      expect(d.memories.activeByType.outcome).toBe(0);
      expect(d.quarantine).toEqual({
        active: 2,
        byCriterion: { pipeline: 0, judge: 1, human_review: 1 },
      });
      expect(d.queue).toEqual({ pending: 5, uncertain: 3, mandatory: 2 });

      const { PgReviewQueueRepository } = await import('../../src/db/reviewQueueRepository.js');
      const counters = await new PgReviewQueueRepository(pool).countQueue(P.dash!.pid);
      expect(d.queue).toEqual({
        pending: counters.pending,
        uncertain: counters.uncertain,
        mandatory: counters.mandatory,
      });
    });

    it('a project without labels has null rates', async () => {
      const d = await repo.getDashboard(P.page!.pid);
      expect(d.judge.falsePositive).toEqual({ count: 0, of: 0, rate: null });
      expect(d.judge.falseNegative).toEqual({ count: 0, of: 0, rate: null });
    });
  });

  // -------------------------------------------------------------------------
  describe('listActivity', () => {
    it('lists state-changing events newest first, never reads', async () => {
      const page = await repo.listActivity(P.act!.pid, { category: null, cursor: null, limit: 50 });
      expect(page.items.map((e) => e.action)).toEqual([
        'review.reject',
        'job.quarantine_purge',
        'memory.retire',
        'review.approve',
        'review.approve',
        'promotion.run',
        'staging.remember',
      ]);
      expect(page.nextCursor).toBeNull();
      const ids = page.items.map((e) => BigInt(e.id));
      expect([...ids].sort((a, b) => (a < b ? 1 : -1))).toEqual(ids);
    });

    it('renders actors by display name only (ci/system unnamed)', async () => {
      const page = await repo.listActivity(P.act!.pid, { category: null, cursor: null, limit: 50 });
      const by = (a: string) => page.items.find((e) => e.action === a)!;
      expect(by('promotion.run').actor).toEqual({ kind: 'ci', name: null });
      expect(by('staging.remember').actor).toEqual({ kind: 'agent', name: 'Ana' });
      expect(by('memory.retire').actor).toEqual({ kind: 'user', name: 'Diego' });
      expect(by('job.quarantine_purge').actor).toEqual({ kind: 'system', name: null });
    });

    it('facts and targets: allow-listed, project-scoped, PII-masked staging titles', async () => {
      const page = await repo.listActivity(P.act!.pid, { category: null, cursor: null, limit: 50 });
      const by = (a: string) => page.items.filter((e) => e.action === a);
      expect(by('promotion.run')[0]!.facts).toEqual({
        branch: 'feature/act',
        prNumber: 12,
        applied: 3,
        queued: 1,
        quarantined: 1,
      });
      expect(by('staging.remember')[0]!.facts).toEqual({ branch: 'feature/act' });
      expect(by('staging.remember')[0]!.target).toEqual({
        kind: 'staging_item',
        type: 'pattern',
        title: 'Contact [EMAIL]',
      });
      const [foreignApprove, ownApprove] = by('review.approve');
      expect(foreignApprove!.target).toBeNull();
      expect(ownApprove!.target).toEqual({
        kind: 'memory',
        type: 'decision',
        title: 'Activity memory',
      });
      expect(by('review.reject')[0]!.target).toBeNull();
      expect(by('job.quarantine_purge')[0]!.facts).toEqual({ count: 2 });
    });

    it('never leaks hashes, identities, emails, session ids or the merge SHA', async () => {
      const page = await repo.listActivity(P.act!.pid, { category: null, cursor: null, limit: 50 });
      const text = JSON.stringify(page);
      for (const leak of [
        'QHASHSECRET',
        'CHASHSECRET',
        'MERGESHASECRET',
        `${PREFIX}-ana`,
        `${PREFIX}-diego`,
        '@insights.test',
        'repo:insights/act',
        'jobs:script',
        act.session!,
        'u-diego',
        'Foreign memory',
        'Foreign item',
        'bob@example.com',
      ]) {
        expect(text).not.toContain(leak);
      }
    });

    it('jobs category: only the job that touched this project, with its count', async () => {
      const page = await repo.listActivity(P.act!.pid, {
        category: 'jobs',
        cursor: null,
        limit: 50,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ action: 'job.quarantine_purge', facts: { count: 2 } });
    });

    it('each category filter returns only events of that category', async () => {
      const { ACTIVITY_CATEGORY } = await import('../../src/db/insightsMapping.js');
      const expected = { review: 3, memory: 1, promotion: 1, staging: 1, quarantine: 0 } as const;
      for (const [category, n] of Object.entries(expected)) {
        const page = await repo.listActivity(P.act!.pid, {
          category: category as keyof typeof expected,
          cursor: null,
          limit: 50,
        });
        expect(page.items).toHaveLength(n);
        for (const e of page.items) expect(ACTIVITY_CATEGORY[e.action]).toBe(category);
      }
    });

    it('keyset pages are disjoint, complete and descending: 50, 50, 20', async () => {
      const pid = P.page!.pid;
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 3; i++) {
        const page = await repo.listActivity(pid, { category: null, cursor, limit: 50 });
        sizes.push(page.items.length);
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
        if (i < 2) expect(cursor).not.toBeNull();
      }
      expect(sizes).toEqual([50, 50, 20]);
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(120);
      const nums = seen.map((s) => BigInt(s));
      for (let i = 1; i < nums.length; i++) expect(nums[i]! < nums[i - 1]!).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('listStaging', () => {
    let login: string;
    let big: string;
    let promoted: string;

    beforeAll(async () => {
      await user(`${PREFIX}-opener`, 'Ana Opener');
      login = await session('stg', 'feature/login', { openedBy: `${PREFIX}-opener` });
      await item(login, { title: 'Ask ana@example.com about retries', minutesAgo: 2 });
      await item(login, {
        state: 'uncertain',
        criterion: 'stale_target',
        mandatory: true,
        minutesAgo: 1,
      });
      big = await session('stg', 'feature/big', { lastActivityDaysAgo: 1 });
      await pool.query(
        `INSERT INTO staging_item (session_id, op, type, title, summary, body, content_hash, author_identity)
         SELECT $1, 'add'::staging_op, 'pattern'::memory_type, 'Bulk ' || g, 'S', 'B', 'bulk-' || g, 'author'
         FROM generate_series(1, 101) g`,
        [big],
      );
      await session('stg', 'restore/xyz');
      await session('stg', 'web/u/abc');
      promoted = await session('stg', 'feature/done', {
        status: 'promoted',
        promotedDaysAgo: 6,
        lastActivityDaysAgo: 6,
        pr: 5,
      });
      await item(promoted, { state: 'accepted', criterion: 'confidence', promoted: true });
      await item(promoted, { state: 'uncertain', criterion: 'grounding', decision: 'rejected' });
      await item(promoted, { state: 'rejected', criterion: 'duplication' });
      await session('stg', 'feature/old', { status: 'abandoned', lastActivityDaysAgo: 8 });
    });

    it('open: reserved sessions excluded, latest activity first, states and masked titles', async () => {
      const s = await repo.listStaging(P.stg!.pid, { status: 'open', limit: 20 });
      expect(s.truncated).toBe(false);
      expect(s.sessions.map((x) => x.branch)).toEqual(['feature/login', 'feature/big']);
      const l = s.sessions[0]!;
      expect(l).toMatchObject({
        id: login,
        status: 'open',
        openedBy: 'Ana Opener',
        closedAt: null,
        itemCount: 2,
        itemsTruncated: false,
        repo: { label: `${PREFIX}/stg` },
      });
      expect(l.items.map((i) => [i.state, i.title])).toEqual([
        ['queued', expect.any(String)],
        ['staged', 'Ask [EMAIL] about retries'],
      ]);
      expect(JSON.stringify(s)).not.toContain('ana@example.com');
      expect(JSON.stringify(s)).not.toContain(`${PREFIX}-opener`);
      for (const i of l.items) {
        expect(Object.keys(i).sort()).toEqual([
          'createdAt',
          'criterion',
          'id',
          'judgeState',
          'mandatoryReview',
          'op',
          'state',
          'title',
          'type',
        ]);
      }
    });

    it('caps items at 100 per session with the real count', async () => {
      const s = await repo.listStaging(P.stg!.pid, { status: 'open', limit: 20 });
      const b = s.sessions.find((x) => x.id === big)!;
      expect(b.itemCount).toBe(101);
      expect(b.items).toHaveLength(100);
      expect(b.itemsTruncated).toBe(true);
    });

    it('limit caps sessions and sets truncated', async () => {
      const s = await repo.listStaging(P.stg!.pid, { status: 'open', limit: 1 });
      expect(s.sessions).toHaveLength(1);
      expect(s.truncated).toBe(true);
    });

    it('closed: only sessions closed in the last 7 days, with final item states', async () => {
      const s = await repo.listStaging(P.stg!.pid, { status: 'closed', limit: 20 });
      expect(s.sessions.map((x) => x.id)).toEqual([promoted]);
      const p = s.sessions[0]!;
      expect(p.closedAt).not.toBeNull();
      expect(p.prNumber).toBe(5);
      expect(p.items.map((i) => i.state).sort()).toEqual([
        'applied',
        'quarantined',
        'review_rejected',
      ]);
    });

    it('another project sees nothing of these sessions', async () => {
      const s = await repo.listStaging(P.page!.pid, { status: 'open', limit: 20 });
      expect(s).toEqual({ sessions: [], truncated: false });
    });
  });
  describe('hardening edge cases', () => {
    const E = () => P.edge!.pid;
    let foreignQuarantine: string;
    let ownQuarantine: string;

    async function log(
      action: string,
      kind: string,
      projectId: string | null,
      detail: unknown,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO access_log (actor_identity, actor_kind, action, project_id, detail)
         VALUES ($1, $2::actor_kind, $3::access_action, $4, $5::jsonb)`,
        [`${PREFIX}-edge`, kind, action, projectId, JSON.stringify(detail)],
      );
    }

    beforeAll(async () => {
      foreignQuarantine = await quarantine('dashq', 'judge', { title: 'Foreign quarantine' });
      ownQuarantine = await quarantine('edge', 'pipeline', { title: 'Mail ana@example.com now' });
      await log('update', 'user', E(), {
        api: 'quarantine.restore',
        quarantineId: foreignQuarantine,
      });
      await log('update', 'user', E(), { api: 'quarantine.restore', quarantineId: ownQuarantine });
      await log('update', 'user', E(), { api: 'totally.unknown' });
      await log('admin', 'system', null, { job: 'mystery-job', detail: { [E()]: 4 } });
      await log('admin', 'system', null, { job: 'quarantine-purge', detail: 'not-an-object' });
      await log('admin', 'system', null, { job: 'quarantine-purge', detail: [E()] });
      await log('stage', 'user', E(), { tool: 'remember', branch: 'b'.repeat(500) });
    });

    it('restore audit pointing at another project quarantine resolves no target; own is masked', async () => {
      const page = await repo.listActivity(E(), {
        category: 'quarantine',
        cursor: null,
        limit: 50,
      });
      expect(page.items.map((e) => e.target)).toEqual([
        { kind: 'quarantine', type: 'gotcha', title: 'Mail [EMAIL] now' },
        null,
      ]);
      expect(JSON.stringify(page)).not.toContain('Foreign quarantine');
    });

    it('unknown job and unknown api map to other through SQL', async () => {
      const page = await repo.listActivity(E(), { category: null, cursor: null, limit: 50 });
      const others = page.items.filter((e) => e.action === 'other');
      expect(others).toHaveLength(2); // unknown api + unknown job
    });

    it('job rows whose detail.detail is not an object are ignored', async () => {
      const page = await repo.listActivity(E(), { category: 'jobs', cursor: null, limit: 50 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ action: 'other', facts: {} });
    });

    it('caps the branch fact at 200 characters', async () => {
      const page = await repo.listActivity(E(), { category: 'staging', cursor: null, limit: 50 });
      expect(page.items[0]!.facts.branch).toHaveLength(200);
    });

    it('repo label is the slug, or the remote URL without userinfo', async () => {
      const { rows } = await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2) RETURNING id`,
        [E(), 'https://user:s3cret@github.com/acme/nameless'],
      );
      const { rows: r2 } = await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2) RETURNING id`,
        [E(), 'git@github.com:acme/scp-style'],
      );
      for (const [rid, branch] of [
        [rows[0].id, 'feature/label-a'],
        [r2[0].id, 'feature/label-b'],
        [P.edge!.rid, 'feature/label-c'],
      ] as const) {
        await pool.query(
          `INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, expires_at)
           VALUES ($1, $2, $3, $4, 'open', $5, now() + interval '7 days')`,
          [`01INSIGHTS${String(++seq).padStart(16, '0')}`, E(), rid, branch, `${PREFIX}-nobody`],
        );
      }
      const out = await repo.listStaging(E(), { status: 'open', limit: 10 });
      const label = (b: string) => out.sessions.find((x) => x.branch === b)!.repo.label;
      expect(label('feature/label-a')).toBe('https://github.com/acme/nameless');
      expect(label('feature/label-b')).toBe('github.com:acme/scp-style');
      expect(label('feature/label-c')).toBe(`${PREFIX}/edge`);
      expect(JSON.stringify(out)).not.toContain('s3cret');
    });
  });
});
