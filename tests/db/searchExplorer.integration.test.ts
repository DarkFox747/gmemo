/**
 * Search explorer parity against real SQL (C13).
 *
 * SKIPPED when DATABASE_URL is unset. Seeds a project with two repos and
 * active + inactive memories (StubEmbedder embeddings), then compares MCP
 * recallHandler (agent whose remote resolves to repo R, project scope, no staged
 * drafts) with GET /api/v1/projects/:p/search?repoId=R on the same pool: the
 * ids and their order must be identical. Also checks the real repo check
 * (foreign repo → 404) and that inactive rows never appear.
 */

import pg from 'pg';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgMemoryRepository } from '../../src/db/memoryRepository.js';
import { PgMemoryAdminRepository } from '../../src/db/memoryAdminRepository.js';
import { StubEmbedder } from '../../src/embedder/stubEmbedder.js';
import { toVectorParam } from '../../src/db/vector.js';
import { recallHandler } from '../../src/mcp/tools/recall.js';
import { decodeHandle } from '../../src/mcp/handle.js';
import type { HandlerDeps, RequestContext } from '../../src/mcp/context.js';
import type { MemoryType } from '../../src/contracts/memory.js';
import type { SearchResponseDto } from '../../src/http/api/types.js';
import type { StagingRepository } from '../../src/db/stagingRepository.js';
import { PROJECT_A, USERS, bearer, makeApiTestApp } from '../http/api/helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// The API test kit's admin is project_admin of PROJECT_A, so the project row
// is inserted with that id.
const SLUG = 'search-explorer-integ';
const OTHER_SLUG = 'search-explorer-integ-other';
const QUERY = 'retry policy for outbound webhooks';

const emptyStaging: StagingRepository = {
  findOrCreateOpenSession: () => Promise.resolve('s'),
  insertStagingItem: () =>
    Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
  listStagingItems: () => Promise.resolve([]),
  discardStagingItem: () => Promise.resolve(false),
};

describeWithDb('search explorer parity with recall (real SQL + StubEmbedder)', () => {
  let pool: pg.Pool;
  let repoR: string;
  let repoS: string;
  let foreignRepo: string;
  const inactiveIds: string[] = [];
  const embedder = new StubEmbedder();
  let seq = 0;

  async function seed(
    repoId: string,
    type: MemoryType,
    title: string,
    summary: string,
    status = 'active',
  ): Promise<string> {
    seq += 1;
    const body = `${title}. ${summary}.`;
    const vec = await embedder.embed(`${title}\n${summary}\n${body}`);
    const { rows } = await pool.query(
      `INSERT INTO memory (project_id, repo_id, type, title, summary, body, status, provenance,
                           author_identity, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pr_reviewed', 'seed-user', $8, $9::vector)
       RETURNING id`,
      [
        PROJECT_A,
        repoId,
        type,
        title,
        summary,
        body,
        status,
        `search-integ-${seq}`,
        toVectorParam(vec),
      ],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    await pool.query(`DELETE FROM project WHERE id = $1 OR slug IN ($2, $3)`, [
      PROJECT_A,
      SLUG,
      OTHER_SLUG,
    ]);
    await pool.query(`INSERT INTO project (id, slug, name) VALUES ($1, $2, $2)`, [PROJECT_A, SLUG]);
    const { rows: other } = await pool.query(
      `INSERT INTO project (slug, name) VALUES ($1, $1) RETURNING id`,
      [OTHER_SLUG],
    );
    const insertRepo = async (projectId: string, url: string): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2) RETURNING id`,
        [projectId, url],
      );
      return rows[0].id as string;
    };
    repoR = await insertRepo(PROJECT_A, 'https://github.com/test/search-integ-r');
    repoS = await insertRepo(PROJECT_A, 'https://github.com/test/search-integ-s');
    foreignRepo = await insertRepo(other[0].id as string, 'https://github.com/test/search-integ-x');

    const topics = ['retry', 'policy', 'webhooks', 'outbound', 'timeouts', 'backoff'];
    for (let n = 0; n < 12; n++) {
      const repo = n % 3 === 0 ? repoR : repoS;
      const type: MemoryType = n % 2 === 0 ? 'decision' : 'gotcha';
      const a = topics[n % topics.length]!;
      const b = topics[(n + 2) % topics.length]!;
      await seed(repo, type, `Note ${n} on ${a} and ${b}`, `How we handle ${a} with ${b}`);
    }
    for (const status of ['superseded', 'deprecated', 'pending_revalidation']) {
      inactiveIds.push(
        await seed(
          repoR,
          'decision',
          `Retry policy for outbound webhooks (${status})`,
          QUERY,
          status,
        ),
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM project WHERE id = $1 OR slug = $2`, [PROJECT_A, OTHER_SLUG]);
    await pool.end();
  });

  function kit() {
    return makeApiTestApp({
      memoryRepository: new PgMemoryRepository(pool),
      embedder,
      memoryAdminRepository: new PgMemoryAdminRepository(pool),
    });
  }

  async function recallIds(limit: number, types?: MemoryType[]): Promise<string[]> {
    const ctx: RequestContext = {
      tenant: { projectId: PROJECT_A, repoId: repoR, branch: 'feature/x' },
      actor: { actorId: 'agent', roles: ['contributor'] },
    };
    const deps: HandlerDeps = {
      memoryRepository: new PgMemoryRepository(pool),
      stagingRepository: emptyStaging,
      embedder,
      notifier: { notify: () => Promise.resolve() },
    };
    const res = await recallHandler({ query: QUERY, scope: 'project', limit, types }, ctx, deps);
    return res.results.map((r) => decodeHandle(r.handle).memoryId);
  }

  it.each([
    [5, undefined],
    [8, undefined],
    [8, ['gotcha'] as MemoryType[]],
  ])('limit %i, types %j: explorer ids equal recall ids in order', async (limit, types) => {
    const qs = new URLSearchParams({ q: QUERY, limit: String(limit), repoId: repoR });
    if (types) qs.set('types', types.join(','));
    const res = await request(kit().app)
      .get(`/api/v1/projects/${PROJECT_A}/search?${qs.toString()}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(200);
    const body = res.body as SearchResponseDto;
    const expected = await recallIds(limit, types);
    expect(expected.length).toBeGreaterThan(0);
    expect(body.items.map((i) => i.id)).toEqual(expected);
    expect(body.repoId).toBe(repoR);
    expect(body.semantic).toBe('ok');
    for (const id of inactiveIds) expect(body.items.map((i) => i.id)).not.toContain(id);
  });

  it('a repo of another project → 404', async () => {
    const qs = new URLSearchParams({ q: QUERY, repoId: foreignRepo });
    const res = await request(kit().app)
      .get(`/api/v1/projects/${PROJECT_A}/search?${qs.toString()}`)
      .set('Authorization', bearer(USERS.adminA));
    expect(res.status).toBe(404);
  });

  it('without repoId no repo priority is applied (pure fused order)', async () => {
    const qs = new URLSearchParams({ q: QUERY, limit: '8' });
    const res = await request(kit().app)
      .get(`/api/v1/projects/${PROJECT_A}/search?${qs.toString()}`)
      .set('Authorization', bearer(USERS.adminA));
    const body = res.body as SearchResponseDto;
    expect(body.repoId).toBeNull();
    // Pure fused order: scores never increase down the list.
    const scores = body.items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
