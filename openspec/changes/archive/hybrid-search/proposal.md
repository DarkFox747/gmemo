# Proposal — hybrid-search (two-phase: lexical-first, semantic fallback)

schema: proposal-v1
change: hybrid-search
status: PROPOSED
date: 2026-07-31
revised: 2026-07-31  # pivot from "fusion-always" to two-phase lexical-first (user decision)

## Problem
`recall` ranks only by BM25 FTS + time-decay — it misses semantically-related memories that don't
share lexical tokens with the query (paraphrase, synonyms). But adding a semantic signal to EVERY
query would put an external embedding call on the hot read path (cost + latency per recall).

## Chosen approach — TWO-PHASE (lexical-first, semantic on-demand)
Keep BM25 as the primary, zero-cost path; escalate to semantic search ONLY when lexical comes up
short. Concretely, in the recall handler on the **first page** (`cursor === null`):
1. **Phase 1 — BM25** (the existing `recall`, UNCHANGED): FTS + time-decay + keyset + COUNT.
2. If Phase 1 returns **≥ N results** → return them as-is. **No embedding call. Zero AWS cost.**
3. **Phase 2 — semantic fallback** (only if Phase 1 `< N`): embed the query via Bedrock Titan v2
   (fail-soft), then run a **vector nearest-neighbor search** (`ORDER BY embedding <=> $qvec LIMIT k`,
   NOT FTS-gated → finds no-lexical-overlap matches, uses the HNSW index), tenant-scoped, excluding
   ids already returned by Phase 1. Append the deduped vector hits to the Phase-1 results.

On subsequent pages (`cursor !== null`) → Phase 1 BM25 keyset only (no embedding, no vector) — keyset
pagination stays intact. Semantic hits are first-page-only extras (mirrors the existing staging-mix pattern).

**Embeddings model**: Bedrock **Titan Text Embeddings V2 → `vector(1024)`** (single `EMBEDDING_DIM` const).
Real Bedrock invoke is DEFERRED behind an injectable `Embedder` seam (deterministic `StubEmbedder` for
local/test; `BedrockEmbedder` skeleton). Memories are embedded at write-time (promotion), so Phase-2
vector search has something to match.

### Why two-phase beats fusion-always (the earlier lean)
- **Cost/latency**: the common case (BM25 confident) makes ZERO embedding calls. Only weak-lexical
  queries pay for one embedding — exactly when semantics adds value.
- **Uses the HNSW index**: Phase 2 is a pure ANN scan (`<=> LIMIT k`) → the index actually accelerates it
  (the fusion-always plan left HNSW unused).
- **Less invasive**: the existing BM25 `recall` SQL, cursor, and COUNT are UNCHANGED — we ADD a vector
  method + handler orchestration, not rewrite the ranked query.

## Two fallbacks (both kept)
- **Cost fallback** (the two-phase above): semantic only when BM25 `< N` results. Trigger = **fewer than N**
  first-page results (N default 5, a constant). (Chosen over score-threshold for pilot simplicity/predictability.)
- **Resilience fail-soft**: if the query embedding fails (Bedrock down/slow) OR a memory has a NULL
  embedding, the system degrades to BM25 — recall NEVER 500s, promotion NEVER blocks.

## Scope

### IN scope
- **Migration 0005**: `CREATE EXTENSION IF NOT EXISTS vector`; `memory.embedding vector(1024)` (nullable);
  HNSW partial index `USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL` — now on the
  hot path (Phase-2 ANN). Header documents superuser / non-CONCURRENTLY / dim-lock caveats.
- **Embedder seam**: `src/embedder/{embedder,stubEmbedder,bedrockEmbedder}.ts` + `EMBEDDING_DIM=1024`;
  deterministic crypto `StubEmbedder` (no dep); `BedrockEmbedder` skeleton (throws; deferred invoke; no aws-sdk).
  `src/db/vector.ts` `toVectorParam`.
- **Config**: `EMBEDDER_STUB`, `BEDROCK_EMBEDDING_MODEL_ID`, `SEMANTIC_FALLBACK_MIN_RESULTS` (N, default 5),
  `SEMANTIC_FALLBACK_K` (vector hits to fetch, default 8) — with the superRefine guard pattern.
- **Write path**: `PromoteService` computes the embedding (fail-soft → NULL) for accepted add/amend/supersede
  (skip deprecate) before `applyAccepted`; `promotionRepository` INSERT/amend gain an `embedding` param.
- **Read path**: `memoryRepository` gains `recallSemantic(tenant, queryEmbedding, filters, excludeIds, k)`
  (vector-only NN search); the recall **handler** orchestrates the two phases (embed only on Phase-2, fail-soft).
  The existing `recall` (BM25) is UNCHANGED.
- **Wiring**: `embedder` in `AppServices` + `HandlerDeps` (recall handler) + `PromoteService` dep; composition-root
  stub-vs-Bedrock selection (guarded + NODE_ENV double-check + banner).
- **Tests**: unit (embedder determinism/dim/fail-soft; config guards; two-phase handler: BM25≥N → no embed;
  BM25<N → embed + vector append + dedupe; embed-fail → BM25-only; cursor page → no phase-2) + DB-gated
  integration (extension/column/index; `recallSemantic` returns a vector-near row via HNSW; NULL-embedding rows excluded).

### OUT of scope (DEFERRED)
- Real `BedrockEmbedder.invokeModel` (VPC PrivateLink + IAM + model access; out-of-band `pnpm add @aws-sdk/*`).
- Query-embedding cache (a later cost optimization; the two-phase already bounds calls).
- Backfill of embeddings for rows promoted before 0005 (separate script).
- `CREATE INDEX CONCURRENTLY` / live-table migration + `rds_superuser` grant (ops).
- Paginating semantic hits (they are first-page-only extras); weighted-score fusion; true RRF.

## Constraints
- pnpm-ONLY; **no new runtime dep** (stub uses `node:crypto`; Bedrock SDK deferred). Parameterized +
  tenant-scoped SQL; `content_tsv` still never written; ESM `.js`; TDD; error opacity unchanged.
- **Fail-soft**: write-time embed error → NULL (never blocks promotion); read-time embed error → BM25-only
  (never 500s). Phase 2 only runs on the first page and only when Phase 1 `< N`.
- Secure-by-default: no new external read surface beyond the guarded embedder; stub impossible in production.

## Affected Areas
| Area | Change |
|------|--------|
| `migrations/0005_embeddings.sql` | vector extension + embedding column + HNSW partial index |
| `src/embedder/*`, `src/db/vector.ts` | Embedder seam + stub + skeleton + EMBEDDING_DIM + serializer |
| `src/config/index.ts` | EMBEDDER_STUB + BEDROCK_EMBEDDING_MODEL_ID + SEMANTIC_FALLBACK_MIN_RESULTS/_K + guards |
| `src/db/promotionRepository.ts` | embedding param on INSERT/amend (deprecate unchanged) |
| `src/promote/promoteService.ts` | compute embedding fail-soft before applyAccepted |
| `src/db/memoryRepository.ts` | NEW `recallSemantic` (vector NN); existing `recall` UNCHANGED |
| `src/mcp/tools/recall.ts` | two-phase orchestration (BM25 → if <N: embed + recallSemantic + dedupe append) |
| `src/mcp/context.ts` + `src/index.ts` | embedder in AppServices + HandlerDeps + PromoteService + composition root |
| `tests/**` | unit + DB-gated integration |

(≫ 3 areas → design REQUIRED.)

## Open design decisions (for architect)
1. Confirm the trigger = Phase-1 first-page results `< SEMANTIC_FALLBACK_MIN_RESULTS` (default 5).
2. `recallSemantic` result ordering + how it merges with Phase-1 (append after BM25, deduped by id) and
   what `total_matches` reports (proposal lean: BM25 FTS count; vector hits are additive extras — document).
3. `source` tag for vector-fallback rows — they are authoritative memories → `source:"main"` (confirm; maybe an
   internal marker for observability).
4. Interaction with the staging-mix prepend (staged first, then BM25, then semantic? confirm order).
5. Confirm `EMBEDDING_DIM=1024` / Titan v2 / StubEmbedder determinism / HNSW-in-migration.
6. Whether Phase-2 applies repo/type filters identically to Phase-1 (it should).

## Rejected alternatives
- **Fusion-always (embed every query)** — rejected (user decision): puts an external call on every read;
  two-phase makes the common case free and still rescues weak-lexical queries.
- **Local/self-hosted embedding model** — rejected (user decision): avoids running our own model; Titan via
  Bedrock, called only on the fallback path.
- **Score-threshold trigger** — deferred: "< N results" is simpler/more predictable for the pilot.
- **Real Bedrock now** — deferred (YAGNI + no dep): stub proves the vertical; real invoke is a drop-in later.
