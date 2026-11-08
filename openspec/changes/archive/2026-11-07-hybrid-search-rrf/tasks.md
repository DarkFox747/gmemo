# Tasks: hybrid-search-rrf (C6)

> Design skipped (single-area change; proposal § Scope is the technical approach). spec ↔ proposal Affected Areas reconciled. TDD per task.

- [x] 1.1 Repository lists: `src/db/memoryRepository.ts` — `recallLexicalCandidates(tenant, {query, scope, types}, 50)` (BM25 with time-decay, ORDER BY rank DESC, id DESC, no keyset/count) and `recallSemantic` called with k=50 and no exclusions; carry `repo_id` in rows; keep parameterized SQL and `status='active'`; update `tests/memory/fakes.ts`; DB-gated test in `tests/integration/hybridSearch.int.test.ts` [declares:CandidateLists]
- [x] 1.2 Pure fusion: `src/search/rrf.ts` — `fuseRrf(lexical, semantic, {k: 60})` (1-based ranks, Σ 1/(k+rank), tie → id), `prioritizeRepo(fused, repoId)` stable partition, offset cursor codec `encodeOffsetCursor`/`decodeOffsetCursor`; unit tests `tests/search/rrf.test.ts` with known rankings (spec scenario A/C/B)
- [x] 2.1 Recall handler: `src/mcp/tools/recall.ts`, `src/mcp/tools/schemas.ts` (limit default 5, max 8), `src/contracts/tools.ts`; fail-soft lexical-only + warn (error name); staged drafts first page only, capped at limit; `total_matches` = fused count; remove `SEMANTIC_FALLBACK_*` from `src/config/index.ts`, `src/mcp/context.ts`, `src/index.ts` and fixtures; rewrite `tests/mcp/recallTwoPhase.test.ts` → `tests/mcp/recallRrf.test.ts`, update `tests/mcp/recall.pagination.test.ts`, `tests/mcp/recall.test.ts`, `tests/memory/recall.test.ts`, `tests/staging/recallMix.test.ts`, `tests/config/embedderGuards.test.ts`, remember/listStaged deps fixtures [consumes:CandidateLists]
- [x] 2.2 Docs: `docs/artefactos/gmemo_facade_contract_v1.md` recall section (RRF, k 5/8, offset cursor justification), `docs/05-tipos-memoria-y-busqueda.md`, README config table (remove SEMANTIC_FALLBACK_*)
- [x] 3.1 Gate: suite + DB gate, lint, build, compose, smoke

- [x] 4.1 Verify fixes: semantic tie-break by id, cursor max length 64, documented repo-priority and offset caveats
