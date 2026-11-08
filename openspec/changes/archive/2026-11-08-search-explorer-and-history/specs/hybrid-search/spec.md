# Delta for Hybrid Search

## ADDED Requirements

### Requirement: Single ranking path with rank provenance

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
