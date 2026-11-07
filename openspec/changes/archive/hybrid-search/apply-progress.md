# Apply Progress — hybrid-search (two-phase)

schema: apply-progress-v1
change: hybrid-search
updated: 2026-07-31

## Batch A — leaf modules ✅
Workers: 3 parallel. Status: SUCCESS. Gate: build + lint + 371 tests green.
- [x] T001 migrations/0005_embeddings.sql (extension + embedding vector(1024) + HNSW partial index + caveat header)
- [x] T002 src/embedder/{embedder,stubEmbedder,bedrockEmbedder}.ts (EMBEDDING_DIM=1024; deterministic stub; throwing skeleton; no aws-sdk)
- [x] T003 src/db/vector.ts (toVectorParam)
- [x] T004 src/config/index.ts (EMBEDDER_STUB + BEDROCK_EMBEDDING_MODEL_ID + SEMANTIC_FALLBACK_MIN_RESULTS=5 + SEMANTIC_FALLBACK_K=8 + 2 superRefine guards)
Deviation: worker added EMBEDDER_STUB='true' to 3 success-path config test fixtures (prodGuard (b), promoteConfig (e)×2) — same pattern as JUDGE_STUB/AUTH_DEV_BYPASS.

## Batch B — atomic core ✅
Worker: 1 (sequential; one build unit). Status: SUCCESS. Gate: build + lint + 371 tests green.
- [x] T005 context.ts (embedder + semanticFallbackMinResults/K in HandlerDeps; embedder in AppServices)
- [x] T006 memoryRepository.ts (ADD recallSemantic + RECALL_SEMANTIC_SQL + extracted mapRow; existing recall UNCHANGED)
- [x] T007 promotionRepository.ts (applyAccepted +embedding; INSERT/amend $12::vector; deprecate unchanged)
- [x] T008 promoteService.ts (embedder dep; fail-soft embed before applyAccepted; deprecate skips)
- [x] T009 recall.ts (two-phase: BM25 → if cursor null & total_matches<N → embed fail-soft + recallSemantic + dedupe append; order staged→BM25→semantic)
- [x] T010 index.ts (embedder if/else + banner; PromoteService dep; Deps assembly passes embedder + fallback config)
- [x] T011 tests/memory/fakes.ts (deterministic recallSemantic via cosine) + 9 other test files updated for widened deps
Deviations: none (test-fixture updates to satisfy widened HandlerDeps are expected).

## Batch C — tests ✅
Workers: 5 parallel. Status: SUCCESS.
- [x] T012 tests/embedder/stubEmbedder.test.ts (determinism/dim/norm/distinct)
- [x] T013 tests/embedder/failSoft.test.ts (BedrockEmbedder throws; caller fail-soft)
- [x] T014 tests/config/embedderGuards.test.ts (guard matrix + fallback defaults)
- [x] T015 tests/mcp/recallTwoPhase.test.ts (a ≥N no-embed / b <N embed+append+dedupe / c embed-throws→BM25 / d cursor→no phase2)
- [x] T016 tests/promote/promoteEmbedding.test.ts (embed per op; deprecate skips; embed-throws→null still applied)
- [x] T017 tests/integration/hybridSearch.int.test.ts (DB-gated; schema + recallSemantic near-before-far + NULL excluded + excludeIds)

## Batch D — consolidated gate ✅
- [x] T018 build clean; 413 tests passed, 89 DB-gated skipped, 0 failed; lint clean.

## APPLY COMPLETE — 18/18. Ready for verify.
