/**
 * T017 — Hybrid-search DB-gated integration tests.
 *
 * SKIPPED when DATABASE_URL is not set (expected in the build gate).
 * When a real Postgres connection string is provided, this exercises:
 *
 *  1. Schema — migration 0005 assertions:
 *     - vector extension is installed
 *     - memory.embedding column is vector(1024)
 *     - idx_memory_embedding_hnsw index exists on memory
 *
 *  2. recallSemantic correctness (vectors controlled directly, not via
 *     semantic meaning — StubEmbedder is deterministic but not semantic):
 *     - near row (embedding = stubEmbed(query)) returned before far row
 *       because cosine distance to queryEmbedding ≈ 0 (identical vector)
 *     - ORDER BY embedding <=> q uses the HNSW index
 *
 *  3. Exclusion invariants:
 *     - rows with embedding IS NULL are never returned by recallSemantic
 *     - excludeIds parameter correctly removes the specified rows from results
 *
 * Seed rows are isolated to a unique PROJECT_SLUG. Teardown deletes the
 * project row which cascades to all repo + memory rows (idempotent).
 *
 * Prerequisites: Postgres 16 at DATABASE_URL with CREATE EXTENSION privileges.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { MemoryRepository } from '../../src/db/memoryRepository.js';

// ---------------------------------------------------------------------------
// Skip guard — entire suite skipped when DATABASE_URL is absent.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Seed constants
// ---------------------------------------------------------------------------

const PROJECT_SLUG = 'hybrid-search-integ-test';
const REPO_URL = 'https://github.com/test/hybrid-search-integ-test';

/**
 * Query text. The "near" row gets embedding = stubEmbed(QUERY_TEXT), so its
 * cosine distance to a query vector of stubEmbed(QUERY_TEXT) is exactly 0.
 */
const QUERY_TEXT = 'hybrid search semantic recall query for integration test';

/**
 * Unrelated text. The "far" row gets embedding = stubEmbed(FAR_TEXT), which
 * is a different unit vector and has cosine distance > 0 from QUERY_TEXT.
 */
const FAR_TEXT = 'completely unrelated text about cooking pasta recipes at home';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithDb('hybrid-search integration — 0005 schema + recallSemantic', () => {
  let pool: pg.Pool | undefined;
  let repo: MemoryRepository | undefined;

  let projectId: string;
  let repoId: string;

  // -------------------------------------------------------------------------
  // beforeAll — migrate (0001 → 0005) + seed project/repo
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });

    // Run the full migration suite (idempotent; applies 0001–0005 if not yet applied).
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);

    // Instantiate repository under test.
    const { PgMemoryRepository } = await import('../../src/db/memoryRepository.js');
    repo = new PgMemoryRepository(pool);

    // -- Seed: project --
    await pool.query(
      `INSERT INTO project (slug, name)
       VALUES ($1, 'Hybrid Search Integration Test')
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
  });

  // -------------------------------------------------------------------------
  // afterAll — idempotent teardown
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (!pool) return;
    // Deleting the project row cascades to: repo, memory (all ON DELETE CASCADE).
    await pool.query(`DELETE FROM project WHERE slug = $1`, [PROJECT_SLUG]);
    await pool.end();
  });

  // =========================================================================
  // 1. Schema assertions — migration 0005
  // =========================================================================

  it('vector extension is installed (pg_extension)', async () => {
    const { rows } = await pool!.query(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].extname).toBe('vector');
  });

  it('memory.embedding column is vector(1024) (format_type)', async () => {
    const { rows } = await pool!.query(
      `SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS col_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'memory'
         AND a.attname = 'embedding'
         AND a.attnum > 0
         AND NOT a.attisdropped`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].col_type).toBe('vector(1024)');
  });

  it('idx_memory_embedding_hnsw index exists on table memory (pg_indexes)', async () => {
    const { rows } = await pool!.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'memory'
         AND indexname = 'idx_memory_embedding_hnsw'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexname).toBe('idx_memory_embedding_hnsw');
  });

  // =========================================================================
  // 2. recallSemantic — ordering (near before far)
  // =========================================================================

  it('recallSemantic returns near row before far row (HNSW cosine order)', async () => {
    const { StubEmbedder } = await import('../../src/embedder/stubEmbedder.js');
    const { toVectorParam } = await import('../../src/db/vector.js');
    const embedder = new StubEmbedder();

    // Compute controlled embeddings (deterministic — same input → same unit vector).
    const nearEmbedding = await embedder.embed(QUERY_TEXT);
    const farEmbedding = await embedder.embed(FAR_TEXT);

    // Insert near row: embedding = stubEmbed(QUERY_TEXT).
    // Cosine distance to queryEmbedding = stubEmbed(QUERY_TEXT) is exactly 0 (same vector).
    const { rows: nearInsertRows } = await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash, embedding)
       VALUES ($1, $2, 'decision',
               'Near semantic row title',
               'Near semantic row summary for hybrid search test.',
               'Near semantic body content. This row should appear first in recallSemantic results.',
               'active', 'pr_reviewed', 'integ-test-user',
               'hybrid-near-001', $3::vector)
       ON CONFLICT (project_id, content_hash) DO NOTHING
       RETURNING id`,
      [projectId, repoId, toVectorParam(nearEmbedding)],
    );
    let nearId: string;
    if (nearInsertRows.length > 0) {
      nearId = nearInsertRows[0].id as string;
    } else {
      const { rows } = await pool!.query(
        `SELECT id FROM memory WHERE project_id = $1 AND content_hash = 'hybrid-near-001'`,
        [projectId],
      );
      nearId = rows[0].id as string;
    }

    // Insert far row: embedding = stubEmbed(FAR_TEXT).
    // Cosine distance to queryEmbedding = stubEmbed(QUERY_TEXT) is positive (different vector).
    const { rows: farInsertRows } = await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash, embedding)
       VALUES ($1, $2, 'decision',
               'Far semantic row title',
               'Far semantic row summary for hybrid search test.',
               'Far semantic body content. This row should appear after the near row in results.',
               'active', 'pr_reviewed', 'integ-test-user',
               'hybrid-far-001', $3::vector)
       ON CONFLICT (project_id, content_hash) DO NOTHING
       RETURNING id`,
      [projectId, repoId, toVectorParam(farEmbedding)],
    );
    let farId: string;
    if (farInsertRows.length > 0) {
      farId = farInsertRows[0].id as string;
    } else {
      const { rows } = await pool!.query(
        `SELECT id FROM memory WHERE project_id = $1 AND content_hash = 'hybrid-far-001'`,
        [projectId],
      );
      farId = rows[0].id as string;
    }

    // Query embedding = stubEmbed(QUERY_TEXT) — identical to nearEmbedding (deterministic).
    const queryEmbedding = await embedder.embed(QUERY_TEXT);
    const tenant = { projectId, repoId, branch: 'main' };

    const results = await repo!.recallSemantic(
      tenant,
      queryEmbedding,
      { scope: 'project' },
      [],
      10,
    );

    const ids = (results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(nearId);
    expect(ids).toContain(farId);

    const nearIdx = ids.indexOf(nearId);
    const farIdx = ids.indexOf(farId);

    // near (cosine distance ≈ 0) must come before far (cosine distance > 0).
    expect(nearIdx).toBeLessThan(farIdx);
  });

  // =========================================================================
  // 3. Exclusion invariants
  // =========================================================================

  it('recallSemantic never returns a row whose embedding IS NULL', async () => {
    // Insert a row without an embedding — omitting the column leaves it NULL.
    await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash)
       VALUES ($1, $2, 'constraint',
               'Null embedding row title',
               'Null embedding row summary.',
               'This row has no embedding and must never appear in recallSemantic results.',
               'active', 'pr_reviewed', 'integ-test-user',
               'hybrid-null-embed-001')
       ON CONFLICT (project_id, content_hash) DO NOTHING`,
      [projectId, repoId],
    );
    const { rows: nullEmbedRows } = await pool!.query(
      `SELECT id FROM memory
       WHERE project_id = $1 AND content_hash = 'hybrid-null-embed-001'`,
      [projectId],
    );
    const nullEmbedId = nullEmbedRows[0].id as string;

    // Verify the row actually has NULL embedding (guard against a re-seed that set one).
    const { rows: checkRows } = await pool!.query(
      `SELECT embedding IS NULL AS is_null FROM memory WHERE id = $1`,
      [nullEmbedId],
    );
    expect(checkRows[0].is_null).toBe(true);

    const { StubEmbedder } = await import('../../src/embedder/stubEmbedder.js');
    const embedder = new StubEmbedder();
    const queryEmbedding = await embedder.embed(QUERY_TEXT);
    const tenant = { projectId, repoId, branch: 'main' };

    // Use a large k to surface all project rows that have embeddings.
    const results = await repo!.recallSemantic(
      tenant,
      queryEmbedding,
      { scope: 'project' },
      [],
      100,
    );

    const ids = (results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(nullEmbedId);
  });

  it('recallSemantic excludes rows listed in excludeIds', async () => {
    const { StubEmbedder } = await import('../../src/embedder/stubEmbedder.js');
    const { toVectorParam } = await import('../../src/db/vector.js');
    const embedder = new StubEmbedder();
    const embedding = await embedder.embed(QUERY_TEXT);

    // Insert a row with a non-null embedding that we will pass in excludeIds.
    await pool!.query(
      `INSERT INTO memory
         (project_id, repo_id, type, title, summary, body,
          status, provenance, author_identity, content_hash, embedding)
       VALUES ($1, $2, 'pattern',
               'Excluded row title',
               'Excluded row summary.',
               'This row will be in excludeIds and must not appear in recallSemantic results.',
               'active', 'pr_reviewed', 'integ-test-user',
               'hybrid-exclude-001', $3::vector)
       ON CONFLICT (project_id, content_hash) DO NOTHING`,
      [projectId, repoId, toVectorParam(embedding)],
    );
    const { rows: excRows } = await pool!.query(
      `SELECT id FROM memory WHERE project_id = $1 AND content_hash = 'hybrid-exclude-001'`,
      [projectId],
    );
    const excludedId = excRows[0].id as string;

    const queryEmbedding = await embedder.embed(QUERY_TEXT);
    const tenant = { projectId, repoId, branch: 'main' };

    const results = await repo!.recallSemantic(
      tenant,
      queryEmbedding,
      { scope: 'project' },
      [excludedId],
      100,
    );

    const ids = (results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(excludedId);
  });
});
