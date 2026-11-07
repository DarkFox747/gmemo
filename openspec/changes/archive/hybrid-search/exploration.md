# Exploration — hybrid-search

schema: exploration-synthesis-v1
change: hybrid-search
date: 2026-07-31
agents: 2 (recall internals · memory-writes + pgvector)
status: COMPLETE

## Headline
Add a vector-similarity signal to `recall`, fused with the existing BM25 + time-decay. Same
local-vertical + deferred-AWS shape as promotion: an injectable `Embedder` seam (deterministic
stub now, real Bedrock deferred). **The key design decision is fusion strategy** — true
rank-based RRF vs. score-based linear fusion — because it interacts with keyset pagination.

## Recall internals (agent A)
- Current `recall` (memoryRepository.ts): 2 CTEs; rank = `ts_rank_cd(content_tsv, websearch_to_tsquery('english'))
  / (1 + age_days/30)`; keyset cursor `base64url("{rank}:{id}")`; `ORDER BY rank DESC, id DESC`;
  keyset WHERE `rank < $ OR (rank = $ AND id < $)`; parallel COUNT query (full match count); limit+1.
- **RRF-vs-keyset tension**: true RRF needs global `ROW_NUMBER()` over both full ranklists →
  cannot be computed incrementally per keyset page (O(N) CTE per request). **Score-based linear
  fusion** (`bm25_time_decay*w1 + COALESCE(1-(embedding <=> $vec),0)*w2`) produces a per-row float
  → cursor shape unchanged (`{score,id}`), keyset + COUNT unchanged. Agent A recommends score-based.
- **NULL embedding fallback**: `COALESCE(1-(embedding <=> $vec), 0)` → rows without an embedding rank
  on BM25+time-decay only. No separate code path.
- **Query must be embedded at search time** via the same Embedder → Embedder must live in AppServices
  and be reachable by recall (handler embeds query, or memoryRepository.recall receives the vector).
- Staging-mix (source:"staged", first-page prepend) is unaffected — it's appended after ranking.
- InMemory fake needs an injectable `scoreFn` so ranking tests stay hermetic.

## Memory writes + pgvector (agent B)
- **Migration 0005**: `CREATE EXTENSION IF NOT EXISTS vector`; `ALTER TABLE memory ADD COLUMN IF NOT
  EXISTS embedding vector(1024)`; `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WHERE
  embedding IS NOT NULL` (HNSW, not IVFFlat — builds on empty tables; partial index skips NULLs).
- **Caveats**: `CREATE EXTENSION vector` needs `rds_superuser` on RDS (ops prereq; fails-then-rolls-back
  cleanly if missing). HNSW without `CONCURRENTLY` locks the table — fine on the pilot's empty/small
  table; a live-table prod rollout needs a separate `CONCURRENTLY` migration (deferred).
- **Write points** (in `promotionRepository.applyAccepted`): `INSERT_MEMORY_SQL` (add + supersede) and
  `UPDATE_MEMORY_AMEND_SQL` (amend) get an `embedding` param; `deprecate` unchanged (no content change).
- **Compute location**: in `PromoteService` (after verdict=accepted, before `applyAccepted`), embedding
  `[title, summary, body].join(' ')`, pass as a param → keeps `PgPromotionRepository` pure SQL.
- **Embedder seam** (mirror Judge): `src/embedder/embedder.ts` (interface `embed(text): Promise<number[]>`
  + `EMBEDDING_DIM = 1024` const) + `BedrockEmbedder` deferred skeleton + `StubEmbedder` (crypto sha256
  chain → L2-normalized 1024-float unit vector; deterministic; NO new dep) + config guard
  (`EMBEDDER_STUB`, `BEDROCK_EMBEDDING_MODEL_ID`) + composition-root if/else + WARN banner.
- **Dimension 1024** (Bedrock Titan Text Embeddings V2; supports 256/512/1024) — single source of truth;
  hard lock-in once data is written.
- **Fail-soft**: an embedding error → write `NULL` + log warn, NEVER block/quarantine the promotion.
- Rows promoted before 0005 have `embedding IS NULL` → invisible to vector search (still in BM25);
  a backfill script is deferred.

## Key decision for the architect
**Fusion strategy**: (a) score-based linear fusion (keyset-preserving, cheap, gracefully degrades —
agent A's recommendation) vs (b) true rank-based RRF (documented intent, but O(N) per page + changes
pagination). Pilot scale is small; both are viable. Resolve + name it honestly in code/docs.
Secondary: fusion weights (w1/w2 or RRF k=60), and whether recall stays FTS-gated (`content_tsv @@ tsq`)
or relaxes to include vector-only matches (changes total_matches semantics).

## Risks
- Dimension 1024 lock-in (re-embed everything to change).
- `CREATE EXTENSION`/HNSW txn + superuser caveats (ops).
- Fake must simulate the vector term (injectable scoreFn) or ranking tests silently pass BM25-only.
- Fail-soft embedding must never block promotion.
- Mislabeling score-fusion as "RRF" causes confusion — name it accurately.

## Cross-cutting resolved
- Embedder goes into AppServices (both write path via PromoteService AND read path via recall use it).
- deprecate op: no embedding write.
