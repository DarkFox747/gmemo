# Exploration: hybrid-search-rrf (C6)

One crombie-explore scope (recall path). Status: COMPLETE.

- **Today** (`src/mcp/tools/recall.ts:43-96`): BM25 always; embed + `recallSemantic` only on the first page when BM25 `totalMatches < SEMANTIC_FALLBACK_MIN_RESULTS`; fail-soft with `logger.warn`. Order is [staged…, bm25…, semantic…]. `total_matches` = BM25 count.
- **BM25 SQL** (`src/db/memoryRepository.ts:234-252`): `websearch_to_tsquery('english')`, rank = `ts_rank_cd / (1 + age_days/30)`, keyset `(rank, id)`, `LIMIT limit+1`. A separate COUNT query (`:255-263`). A top-50 ordered list is trivial: `ORDER BY rank DESC, id DESC LIMIT 50`.
- **Repo boost is not implemented anywhere**: `scope=repo` is a hard filter; `scope=project` has no boost. The contract says "repo primero" (`docs/artefactos/gmemo_facade_contract_v1.md:54`).
- **Semantic SQL** (`:267-279`): cosine `<=>` over the HNSW partial index, `id <> ALL(exclude)`, `LIMIT k`. It already returns an ordered top-K list.
- **Response**: `{results: MemoryRecord[], total_matches, cursor}`; `source` is `main|staged` (`src/contracts/tools.ts:9-21`).
- **Staged mix**: own open session, first page only, **no LIMIT** (`src/db/stagingRepository.ts:186-195`).
- **Cursor**: base64url `rank:uuid`, used only by BM25 keyset (`:94-126`). Tests depend on it: `tests/mcp/recall.pagination.test.ts:136-181`, `tests/memory/recall.test.ts:297-368`.
- **Audit**: in `src/mcp/tools/index.ts:72-96` before the handler (unchanged).
- **StubEmbedder**: SHA-256 vectors with no semantics, so tests inject fixed vectors through the fake repo (`tests/memory/fakes.ts:255-289`).
- **Config**: `SEMANTIC_FALLBACK_MIN_RESULTS`/`_K` (`src/config/index.ts:102-105`), wired through context/index. Limit today is default 8, max 50 (`recall.ts:28-29`, `schemas.ts:39-45`).
- **Tests that break**: `tests/mcp/recallTwoPhase.test.ts`, `recall.pagination.test.ts`, `recall.test.ts`; `tests/memory/recall.test.ts`, `fakes.ts`; `tests/staging/recallMix.test.ts` and the deps fixtures in remember/listStaged; `tests/config/embedderGuards.test.ts` (SEMANTIC_* vars); `tests/integration/hybridSearch.int.test.ts`.
