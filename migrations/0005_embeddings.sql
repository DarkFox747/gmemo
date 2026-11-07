-- Migration 0005: pgvector extension + embedding column + HNSW index for
-- two-phase (lexical→semantic) recall (hybrid-search change).
-- Idempotent: safe to apply more than once (IF NOT EXISTS / IF NOT EXISTS
-- guards on every DDL statement). Standalone: needs only DATABASE_URL.
--
-- OPS CAVEATS (read before applying to a non-pilot environment):
--   * CREATE EXTENSION vector requires rds_superuser on RDS. If the role lacks it,
--     this migration fails and the runner's per-file transaction (src/db/migrate.ts)
--     rolls back cleanly (schema_migrations is NOT updated) — grant rds_superuser
--     out-of-band, then re-run.
--   * The migration runner executes each file inside ONE BEGIN/COMMIT. CREATE INDEX
--     CONCURRENTLY is therefore FORBIDDEN here (it cannot run in a transaction). The
--     non-CONCURRENTLY HNSW build below takes an ACCESS EXCLUSIVE lock — safe on the
--     pilot's empty/tiny table. A live-table prod rollout MUST use a separate
--     out-of-transaction CONCURRENTLY migration (DEFERRED).
--   * This HNSW index IS on the hot path: it accelerates the Phase-2 vector-only NN
--     query (ORDER BY embedding <=> q LIMIT k) in memoryRepository.recallSemantic.
--     It adds write-amplification (graph maintenance) on every embedded INSERT/UPDATE;
--     negligible at pilot volume.
--   * Dimension 1024 (Bedrock Titan Text Embeddings V2) is a HARD lock-in once data is
--     written — changing it requires re-embedding every row. Keep in sync with
--     EMBEDDING_DIM in src/embedder/embedder.ts.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw
  ON memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
