# Tasks — hybrid-search (two-phase: lexical-first, semantic fallback)

schema: tasks-v1
change: hybrid-search
status: READY
date: 2026-07-31
revised: 2026-07-31  # two-phase (was fusion-always)

Batch letters mark file-independence. Deps flow A→B→C→D. Existing BM25 `recall` stays UNCHANGED.

## Batch A — leaf modules (independent files, parallel)
- [x] **T001** Create `migrations/0005_embeddings.sql` — CREATE EXTENSION vector + `embedding vector(1024)` +
  HNSW partial index; header caveats (superuser / non-CONCURRENTLY / dim-lock; HNSW on hot path). [REQ-01,02]
- [x] **T002** Create `src/embedder/embedder.ts` (interface + `EMBEDDING_DIM=1024`), `src/embedder/stubEmbedder.ts`
  (deterministic crypto sha256-chain → L2-normalized 1024-vec), `src/embedder/bedrockEmbedder.ts`
  (throws; deferred invokeModel; no aws-sdk). [REQ-03,04,05]
- [x] **T003** Create `src/db/vector.ts` — `toVectorParam(vec|null) → '[...]'|null`. [REQ-06]
- [x] **T004** Modify `src/config/index.ts` — `EMBEDDER_STUB`, `BEDROCK_EMBEDDING_MODEL_ID`,
  `SEMANTIC_FALLBACK_MIN_RESULTS` (default 5), `SEMANTIC_FALLBACK_K` (default 8) + superRefine guards
  (stub prod-forbidden; model-id required when stub off). Adjust any minimal test fixture like the judge did (report it). [REQ-07,08]

## Batch B — atomic core (interface widening + additive repo method; ONE worker, sequential)
- [x] **T005** Modify `src/mcp/context.ts` — add `embedder: Embedder` to `AppServices` AND `HandlerDeps`;
  add `semanticFallbackMinResults: number` + `semanticFallbackK: number` to `HandlerDeps` (+ imports). [REQ-18]
- [x] **T006** Modify `src/db/memoryRepository.ts` — ADD `recallSemantic(tenant, queryEmbedding, filters,
  excludeIds, k)` (vector NN: `ORDER BY embedding <=> $ LIMIT k`, tenant-scoped, status active, embedding NOT NULL,
  scope/type filters as recall, `id <> ALL($::uuid[])`); extract a shared row mapper. **Do NOT change the
  existing `recall`/RECALL_PAGE_SQL/cursor/COUNT.** [REQ-12,13]
- [x] **T007** Modify `src/db/promotionRepository.ts` — `applyAccepted(item, ctx, embedding)`; add
  `embedding = $12::vector` to INSERT_MEMORY_SQL (add+supersede) and UPDATE_MEMORY_AMEND_SQL (amend);
  deprecate unchanged; bind `toVectorParam(embedding)`. [REQ-11]
- [x] **T008** Modify `src/promote/promoteService.ts` — constructor `+embedder`; compute embedding fail-soft
  (`title\nsummary\nbody`) before `applyAccepted` for add/amend/supersede, skip deprecate. [REQ-09,10]
- [x] **T009** Modify `src/mcp/tools/recall.ts` — two-phase: run BM25 (unchanged); if `cursor===null` AND
  `total_matches < semanticFallbackMinResults` → embed query fail-soft (error → skip), call `recallSemantic`
  (excludeIds = BM25 ids, k = semanticFallbackK), dedupe + append after BM25. Order: staged → BM25 → semantic.
  total_matches = BM25 count. [REQ-14,15,16,17]
- [x] **T010** Modify `src/index.ts` — embedder if/else (stub vs Bedrock, guarded + NODE_ENV double-check + banner);
  `PromoteService` gets `embedder`; `AppServices` assembly gets `embedder`; ensure the per-request `Deps` assembly
  passes `embedder` + `semanticFallbackMinResults` + `semanticFallbackK` to the recall handler (verify the assembly site). [REQ-18]
- [x] **T011** Modify `tests/memory/fakes.ts` — add a deterministic `recallSemantic` to `InMemoryMemoryRepository`
  (rank seeded rows by cosine/negative-distance to the query vector; honor excludeIds/filters); keep existing `recall` fake behavior. [REQ-19]

(Rationale: widening `AppServices`/`HandlerDeps` + PromoteService dep + the recall handler needing the new fields
form one build unit. `memoryRepository` change is purely ADDITIVE — existing recall untouched.)

## Batch C — tests (independent files, parallel)
- [x] **T012** Create `tests/embedder/stubEmbedder.test.ts` — determinism + dim + unit-norm + distinct inputs. [REQ-19]
- [x] **T013** Create `tests/embedder/failSoft.test.ts` — BedrockEmbedder throws; throwing fake → caller fail-soft. [REQ-19]
- [x] **T014** Create `tests/config/embedderGuards.test.ts` — superRefine matrix + fallback-config defaults. [REQ-19]
- [x] **T015** Create `tests/mcp/recallTwoPhase.test.ts` — (a) BM25 ≥N → embedder NOT called; (b) BM25 <N →
  embed + recallSemantic + deduped append (order staged→BM25→semantic); (c) embed throws → BM25-only, no 500;
  (d) cursor page → Phase 2 never runs; total_matches = BM25 count. [REQ-19]
- [x] **T016** Create `tests/promote/promoteEmbedding.test.ts` — promote writes embedding; embed error → NULL still
  applied; deprecate skips embed. [REQ-19]
- [x] **T017** Create `tests/integration/hybridSearch.int.test.ts` (DB-gated) — extension/column/index exist;
  `recallSemantic` returns a vector-near seeded row (vectors controlled directly) via HNSW; NULL-embedding excluded. [REQ-20]

## Batch D — gate
- [x] **T018** Run `pnpm build && pnpm test -- --run && pnpm lint` — all green; existing 371 stay passing. [REQ-21]

## Notes
- Scope fence (REQ-22): NO real Bedrock/aws-sdk, NO query cache, NO backfill, NO CONCURRENTLY index, NO paginating
  semantic hits, NO weighted fusion / RRF. Existing BM25 recall SQL/cursor/COUNT untouched. Stub + skeleton only.
