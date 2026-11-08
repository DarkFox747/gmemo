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

`EMBEDDER_STUB` and `BEDROCK_EMBEDDING_MODEL_ID` MUST be validated by `superRefine`: the stub is forbidden when `NODE_ENV=production` and the model id is required when the stub is off. The composition root MUST add a `NODE_ENV !== 'production'` double-check and a WARN banner. `(removed in hybrid-search-rrf) SEMANTIC_FALLBACK_MIN_RESULTS` (default 5) and `SEMANTIC_FALLBACK_K` (default 8) MUST be validated numeric config.

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

### Requirement: Reciprocal Rank Fusion (HU-08.1)

Source: hybrid-search-rrf

`recall` SHALL combine up to 50 lexical candidates (BM25 with time-decay) and up to 50 semantic candidates (vector similarity), restricted to active memories of the project (and type/scope filters), fusing them with `score = Σ 1/(60 + rank)`; ties broken deterministically. It SHALL return up to `limit` complete units ordered by fused score; `limit` defaults to 5 and MUST NOT exceed 8.

#### Scenario: Fusion order with known rankings
- GIVEN memory A ranked 1st lexically and 3rd semantically, B 2nd lexically and absent semantically, and C absent lexically and 1st semantically
- WHEN recall runs
- THEN the order is A (1/61+1/63), C (1/61), B (1/62)

#### Scenario: Limit bounds
- GIVEN 20 matching memories
- WHEN recall is called without limit and with limit 9
- THEN the first returns 5 results and the second is rejected as invalid input

### Requirement: Fail-soft semantic side

Source: hybrid-search-rrf

If embedding or the semantic query fails, recall SHALL return the lexical ranking alone and MUST log a warning (no silent failure).

#### Scenario: Embedder down
- GIVEN the embedder throws
- WHEN recall runs
- THEN lexical results are returned and one warning is logged

### Requirement: Repo priority and drafts (HU-08.3, HU-08.4 regression)

Source: hybrid-search-rrf

With project scope, results from the query's repository SHALL come before the rest of the project; the caller's own drafts on the current branch SHALL be prepended on the first page marked `source:"staged"`, at most `limit` of them.

#### Scenario: Repo first
- GIVEN two equally relevant memories, one in the query's repo and one in another repo
- WHEN recall runs with project scope
- THEN the query-repo memory comes first

### Requirement: Offset pagination over the fused list

Source: hybrid-search-rrf

`recall` SHALL page through the fused list with an opaque cursor while keeping the response shape `{results, total_matches, cursor}`; an invalid cursor fails with the opaque invalid-reference error.

#### Scenario: Second page does not overlap
- GIVEN 12 fused candidates and limit 5
- WHEN the client follows the cursor twice
- THEN pages of 5, 5 and 2 are returned without duplicates and the last cursor is null

## History

| Requirement | Source | Superseded by |
|---|---|---|
| `BedrockEmbedder.embed` throws (real `invokeModel` deferred, no `@aws-sdk` import) | hybrid-search | real-bedrock-clients (real Titan v2 embedder; see `bedrock-clients`) |
| Two-phase recall (lexical first, semantic fallback) | hybrid-search | hybrid-search-rrf |
| Result ordering and counts (keyset cursor, BM25 total) | hybrid-search | hybrid-search-rrf |

### Requirement: Single ranking path with rank provenance

Source: search-explorer-and-history


Source: search-explorer-and-history

Hybrid ranking SHALL live in one function, `rankActiveMemories`, in `src/search/hybridSearch.ts`. It takes the lexical and semantic candidates (top 50 each, active only, type and scope filters), fuses them with RRF (k = 60) and applies repo priority when the scope is project and a repo is given. It returns `{ ranked, semantic: 'ok' | 'unavailable' }`. MCP `recall` and the web search explorer MUST both use it, and neither MAY re-implement fusion. Each fused candidate SHALL carry `lexicalRank` and `semanticRank` (1-based position in each list, `null` when absent), recorded by `fuseRrf` itself. Adding these fields MUST NOT change scores, tie-breaks, order, limits, pagination or the `recall` response shape. `recall` ignores `semantic` and the rank fields. A repo-scoped search without a repo MUST fail as an internal error rather than widen to the project.

#### Scenario: Provenance recorded during fusion
- GIVEN memory A ranked 1st lexically and 3rd semantically and memory B ranked 2nd lexically only
- WHEN the lists are fused
- THEN A has `lexicalRank` 1 and `semanticRank` 3, B has `lexicalRank` 2 and `semanticRank` null, and the order and scores equal the previous fusion

#### Scenario: Recall unchanged
- GIVEN the existing recall fixtures (fusion order, limits, fail-soft, repo priority, pagination, staged drafts)
- WHEN recall runs after the extraction
- THEN every existing result and response shape is identical

#### Scenario: Semantic availability reported
- GIVEN the embedder throws
- WHEN `rankActiveMemories` runs
- THEN it returns the lexical ranking with `semantic: 'unavailable'` and logs one warning (error name only)

#### Scenario: No repo means no priority
- GIVEN project scope and no repo
- WHEN `rankActiveMemories` runs
- THEN the result is the pure fused order
