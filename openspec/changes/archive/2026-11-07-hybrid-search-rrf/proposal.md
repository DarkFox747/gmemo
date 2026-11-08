# Proposal: hybrid-search-rrf (C6) — HU-08

## Intent
The TFG specifies hybrid search as Reciprocal Rank Fusion of lexical and semantic rankings, k = 5 by default and configurable up to 8. The code uses two phases with limit 8/50. This closes divergence 1.

## Scope

### In Scope
1. **Fusion**:
   - Lexical candidates: top 50 by BM25 with time-decay.
   - Semantic candidates: top 50 by pgvector cosine.
   - Both are filtered by project, `status='active'`, types and scope, and fused with `score(d) = Σ 1/(60 + rank_i(d))` (rank from 1). Ties are broken by memory id for determinism.
2. **Repo priority (HU-08.3)**: with `scope=project` (default), results from the query's repo come first by fused score, then the rest of the project. `scope=repo` keeps the hard filter.
3. **Fail-soft**: if embedding or the semantic query fails, the lexical list alone is used and a warning is logged (error name only). Never silent.
4. **Limit**: default **5**, max **8** (zod). `total_matches` = number of fused candidates.
5. **Pagination**: an opaque offset cursor over the fused list (`base64url("o:<offset>")`) with the same response shape. Keyset over a fused, query-time score has no stable key, so this is justified in the design. Invalid cursor → INVALID_REFERENCE.
6. **Staged drafts (HU-08.4)**: own drafts of the current branch, first page only, prepended and marked `source:"staged"`, capped at `limit`.
7. Remove `SEMANTIC_FALLBACK_*` config. RRF constants (k=60, 50 candidates) are named constants, not config (YAGNI).
8. Update the contract (`docs/artefactos/gmemo_facade_contract_v1.md`) and `docs/05`. Deterministic fusion tests with known rankings (fake repo with injected vectors).

### Out of Scope
Token budget enforcement, re-ranking models, query expansion.

## Affected Areas
`src/mcp/tools/recall.ts`, `src/db/memoryRepository.ts`, `src/mcp/tools/schemas.ts`, `src/contracts/tools.ts`, `src/mcp/context.ts`, `src/config/index.ts`, `src/index.ts`, tests (memory/mcp/staging/config/integration), docs.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Two queries per recall cost an embedding call each time | Med | Accepted by the TFG design; fail-soft; stub in the demo |
| Offset cursor shifts if data changes between pages | Low | Documented; pages are short (max 8) |

## Rollback Plan
Revert the commit. No schema change.

## Success Criteria
- [ ] HU-08.1 (fusion, k default 5 / max 8, relevance order) and HU-08.2 (non-active excluded) tests; regression for HU-08.3–5; suite, DB gate, lint, build, smoke green.
