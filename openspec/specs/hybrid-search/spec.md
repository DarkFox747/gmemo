# Hybrid Search Specification

## Purpose

Two-phase `recall`: lexical BM25 first, with a vector-similarity fallback (pgvector, 1024 dimensions) when lexical results are too few. Embeddings are written at promotion time, fail-soft. The embedder stub is dev/test only and impossible in production.

## Requirements

### Requirement: Embeddings migration (0005)

`migrations/0005_embeddings.sql` MUST be idempotent: `CREATE EXTENSION IF NOT EXISTS vector`, `memory.embedding vector(1024)` (nullable, `ADD COLUMN IF NOT EXISTS`) and an HNSW partial index `USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`. The header MUST document the caveats: `rds_superuser` is needed for the extension, no `CREATE INDEX CONCURRENTLY` (one transaction per file), and the dimension 1024 lock-in.

Source: hybrid-search

#### Scenario: Migration applied

- GIVEN a Postgres with the pgvector extension available
- WHEN migration 0005 runs, twice
- THEN the extension, column and index exist and the second run is a no-op

### Requirement: Embedder seam

`src/embedder/embedder.ts` MUST export `EMBEDDING_DIM = 1024` and an `Embedder` interface `embed(text): Promise<number[]>`. `StubEmbedder` MUST be deterministic, dependency-free (`node:crypto`) and return an L2-normalized vector of `EMBEDDING_DIM` length; it is DEV/TEST only. `src/db/vector.ts` `toVectorParam(vec|null)` MUST return a `'[...]'` literal or `null`.

Source: hybrid-search

#### Scenario: Stub determinism

- GIVEN the same input text
- WHEN embedding twice with `StubEmbedder`
- THEN identical 1024-length normalized vectors are returned

### Requirement: Embedder stub guard and fallback config

`EMBEDDER_STUB` and `BEDROCK_EMBEDDING_MODEL_ID` MUST be validated by `superRefine`: the stub is forbidden when `NODE_ENV=production` and the model id is required when the stub is off. The composition root MUST add a `NODE_ENV !== 'production'` double-check and a WARN banner. `SEMANTIC_FALLBACK_MIN_RESULTS` (default 5) and `SEMANTIC_FALLBACK_K` (default 8) MUST be validated numeric config.

Source: hybrid-search

#### Scenario: Stub in production

- GIVEN `NODE_ENV=production` and `EMBEDDER_STUB=true`
- WHEN configuration is loaded
- THEN loading fails with an explicit error

### Requirement: Fail-soft write-time embedding

`PromoteService.promote` MUST compute the embedding (`title\nsummary\nbody`) for accepted add, amend and supersede items before `applyAccepted`; `deprecate` MUST NOT embed. A write-time embedding error MUST write the item with `embedding = NULL` and a warning, and promotion MUST still succeed. `applyAccepted(item, ctx, embedding)` MUST bind the embedding via `$N::vector` on INSERT (add, supersede) and amend UPDATE, with NULL binding SQL NULL; `content_tsv` stays GENERATED and out of column lists.

Source: hybrid-search

#### Scenario: Embedder fails at promote

- GIVEN the embedder throws for an accepted add
- WHEN promoting
- THEN the memory is written with `embedding = NULL` and the promotion succeeds

### Requirement: Two-phase recall

Phase 1 MUST be the existing `memoryRepository.recall`, unchanged (SQL, keyset cursor, params and COUNT). `memoryRepository.recallSemantic(tenant, queryEmbedding, filters, excludeIds, k)` MUST run a parameterized vector nearest-neighbour search `ORDER BY embedding <=> $qvec LIMIT k`, tenant-scoped, `status='active'`, `embedding IS NOT NULL`, with the same repo/type filters as recall and excluding `excludeIds`. The handler MUST run Phase 2 ONLY when `cursor === null` AND Phase-1 `total_matches < SEMANTIC_FALLBACK_MIN_RESULTS`. Phase 2 MUST embed the query fail-soft: on error it logs a warning and returns Phase-1 results only, never a 500.

Source: hybrid-search

#### Scenario: Enough lexical results

- GIVEN BM25 returns at least N matches
- WHEN calling `recall`
- THEN the embedder is not called

#### Scenario: Few lexical results

- GIVEN BM25 returns fewer than N matches and no cursor
- WHEN calling `recall`
- THEN the query is embedded, `recallSemantic` runs, and hits are appended deduplicated

#### Scenario: Embedder error on read

- GIVEN the embedder throws
- WHEN calling `recall`
- THEN BM25-only results are returned without error

#### Scenario: Subsequent page

- GIVEN a request with a cursor
- WHEN calling `recall`
- THEN Phase 2 never runs

### Requirement: Result ordering and counts

Semantic hits MUST be appended after BM25 results and deduplicated by id. First-page order MUST be staged, then BM25, then semantic. `total_matches` MUST reflect the BM25 count only, semantic hits are additive, vector rows carry `source:"main"`, and the keyset cursor stays BM25-only.

Source: hybrid-search

#### Scenario: Deduplication

- GIVEN a memory returned by both phases
- WHEN merging
- THEN it appears once

### Requirement: Embedder wiring

`embedder: Embedder` MUST be part of `AppServices` and `HandlerDeps`; the recall handler MUST also receive `semanticFallbackMinResults` and `semanticFallbackK`; `PromoteService` MUST receive `embedder` as a constructor dependency. It MUST be constructed once at the composition root (stub or Bedrock, config-guarded).

Source: hybrid-search

#### Scenario: Single construction

- GIVEN app boot
- WHEN services are assembled
- THEN one embedder instance is shared by recall and promotion

### Requirement: Hybrid-search test coverage

Unit tests MUST cover the stub (determinism, dimension, norm), the config guard matrix, the two-phase handler cases above, and promote embedding write, fail-soft NULL and deprecate skipping. DB-gated integration tests (skipped without `DATABASE_URL`, using `StubEmbedder`) MUST assert the extension, column and index exist, that `recallSemantic` returns a vector-near seeded row via HNSW and that rows with `embedding IS NULL` are excluded.

Source: hybrid-search

#### Scenario: Null embedding excluded

- GIVEN a row with `embedding IS NULL`
- WHEN running `recallSemantic`
- THEN the row is not returned

## History

| Requirement | Source | Superseded by |
|---|---|---|
| `BedrockEmbedder.embed` throws (real `invokeModel` deferred, no `@aws-sdk` import) | hybrid-search | real-bedrock-clients (real Titan v2 embedder; see `bedrock-clients`) |
