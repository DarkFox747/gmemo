# Delta for Web API

## ADDED Requirements

### Requirement: Agent search explorer endpoint

`GET /api/v1/projects/:projectId/search` SHALL be available only to the project's `project_admin`. Any other caller (non-member, contributor, viewer, foreign or unknown project) MUST receive the uniform opaque 404 before any validation runs. The endpoint SHALL accept only these query parameters (strict; anything else → 400):
- `q`: trimmed, 1–200 characters, required
- `types`: optional comma-separated subset of the memory types, at least one
- `limit`: integer 1–8, default 5
- `repoId`: optional UUID

It SHALL rank with the same function MCP `recall` uses (`rankActiveMemories`), with project scope, and return the first `limit` results as `{ items, totalCandidates, semantic, repoId }`. Each item SHALL carry:
- `position`
- `id`, `type`, `title`, `summary`, `repoId`, `version`, `updatedAt`
- `score` (RRF fused)
- `lexicalRank` and `semanticRank` (1-based, `null` when absent)

Only active memories SHALL be returned. Staged drafts SHALL NOT be returned.

Source: search-explorer-and-history

#### Scenario: Ranked results with provenance
- GIVEN memory A ranked 1st lexically and 3rd semantically, C absent lexically and 1st semantically, and B 2nd lexically and absent semantically
- WHEN the project_admin searches the same query
- THEN the items are A, C, B with A `lexicalRank` 1 and `semanticRank` 3, C `lexicalRank` null and `semanticRank` 1, B `semanticRank` null, and each `score` equals Σ 1/(60 + rank)

#### Scenario: Non-admin denied opaquely
- GIVEN a contributor or viewer of the project
- WHEN they call the search endpoint, even with invalid parameters
- THEN the response is the uniform 404

#### Scenario: Invalid input rejected
- GIVEN a project_admin
- WHEN `q` is missing, whitespace-only or 201 characters, or `limit` is 0, 9 or non-numeric, or `types` is empty or names an unknown type, or an unknown or repeated parameter is sent, or `repoId` is not a UUID
- THEN the response is 400 with the opaque invalid-request body

#### Scenario: Default and maximum limit
- GIVEN 20 matching active memories
- WHEN searching without `limit` and with `limit=8`
- THEN 5 and 8 items are returned and `totalCandidates` is the size of the fused candidate list

#### Scenario: Inactive memories excluded
- GIVEN superseded, deprecated and pending-revalidation memories that match the query
- WHEN searching
- THEN none of them is returned

### Requirement: Explorer repo boost validated against the project

Without `repoId`, the search SHALL apply no repository priority (pure fused order). With `repoId`, the repo MUST belong to the path's project, otherwise the response is the uniform 404. Memories of that repo SHALL then come first, preserving fused order within each group, exactly as `recall` does for an agent whose remote resolves to that repo. The response `repoId` SHALL echo the applied boost (`null` when none). The endpoint MUST NOT read `X-Git-Remote` or `X-Git-Branch`.

Source: search-explorer-and-history

#### Scenario: Foreign repo rejected
- GIVEN a well-formed `repoId` of another project's repository
- WHEN the project_admin searches with it
- THEN the response is the uniform 404

#### Scenario: Parity with recall
- GIVEN a project with memories in repos R and S and an agent whose `X-Git-Remote` resolves to R
- WHEN the agent calls `recall` (project scope, no staged drafts, limit N) and the project_admin searches the same query with `repoId=R` and `limit=N`
- THEN the explorer item ids equal the recall result ids in the same order

### Requirement: Embedder fail-soft reported

If embedding the query or the semantic candidate query fails, the endpoint SHALL return 200 with the lexical ranking, `semantic: "unavailable"`, `semanticRank: null` on every item, and one warning log carrying the error name only. Otherwise `semantic` SHALL be `"ok"`, including when the semantic list is legitimately empty.

Source: search-explorer-and-history

#### Scenario: Embedder down
- GIVEN the embedder throws
- WHEN the project_admin searches
- THEN the response is 200 with lexical results, `semantic` is `"unavailable"` and a single warning is logged without the query text

### Requirement: Explorer search audited like recall

A successful search SHALL be recorded with the read action `memories.search`, the result count and `query_hash = sha256(lowercase(trim(q)))`. That is the same normalisation as MCP `recall`. The raw query and the repo id MUST NOT be stored. Failed requests (400/404) are not audited, as with other REST reads.

Source: search-explorer-and-history

#### Scenario: Query stored as hash
- GIVEN a project_admin searching "  Retry Policy "
- WHEN the search succeeds
- THEN `access_log` has a `memories.search` read whose `query_hash` equals the hash of "retry policy" and no audit field contains the query text
