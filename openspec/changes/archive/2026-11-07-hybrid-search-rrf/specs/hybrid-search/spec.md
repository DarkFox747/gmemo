# Delta for hybrid-search

## REMOVED Requirements

### Requirement: Two-phase search (lexical first, semantic fallback)
(Reason: replaced by Reciprocal Rank Fusion per the TFG document, HU-08.1.)

## ADDED Requirements

### Requirement: Reciprocal Rank Fusion (HU-08.1)

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

If embedding or the semantic query fails, recall SHALL return the lexical ranking alone and MUST log a warning (no silent failure).

#### Scenario: Embedder down
- GIVEN the embedder throws
- WHEN recall runs
- THEN lexical results are returned and one warning is logged

### Requirement: Repo priority and drafts (HU-08.3, HU-08.4 regression)

With project scope, results from the query's repository SHALL come before the rest of the project; the caller's own drafts on the current branch SHALL be prepended on the first page marked `source:"staged"`, at most `limit` of them.

#### Scenario: Repo first
- GIVEN two equally relevant memories, one in the query's repo and one in another repo
- WHEN recall runs with project scope
- THEN the query-repo memory comes first

### Requirement: Offset pagination over the fused list

`recall` SHALL page through the fused list with an opaque cursor while keeping the response shape `{results, total_matches, cursor}`; an invalid cursor fails with the opaque invalid-reference error.

#### Scenario: Second page does not overlap
- GIVEN 12 fused candidates and limit 5
- WHEN the client follows the cursor twice
- THEN pages of 5, 5 and 2 are returned without duplicates and the last cursor is null
