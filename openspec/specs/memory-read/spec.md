# Memory Read Specification

## Purpose

The memory read tables, the `MemoryRepository`, and the real, project-scoped implementations of `recall`, `get_memory` and `get_context` over RDS. Staging and semantic fallback layered on top of `recall` are specified in `staging` and `hybrid-search`.

## Requirements

### Requirement: Memory schema (migration 0002)

`migrations/0002_memory.sql` MUST create `memory`, `memory_revision` and `memory_relation` with their enums, faithful to schema v2, forward-only and idempotent, and MUST NOT create staging tables. `memory.content_tsv` MUST be a GENERATED STORED tsvector using the `english` dictionary with weights title=A, summary=B, body=C, plus a GIN index. Indexes MUST include a composite `(project_id, status, type)` and a partial index `WHERE ttl_days IS NOT NULL`. Content budgets (title <= 120, summary <= 200, body <= 2000) MUST stay enforced as CHECK constraints.

Source: data-model

#### Scenario: Migration applied

- GIVEN a database with migration 0001
- WHEN migration 0002 runs
- THEN the tables, enums and indexes exist, and a DB-gated test asserts this and skips when `DATABASE_URL` is unset

### Requirement: MemoryRepository

A `MemoryRepository` interface and `PgMemoryRepository` (pg Pool in the constructor) MUST follow the `AuthRepository` pattern. All SQL MUST be parameterized, with no concatenation of query, scope or branch. The repository MUST be constructed once at boot and injected via `deps`, and handler signatures `(input, ctx, deps)` MUST NOT be reshaped. `AppServices = AuthServices & { memoryRepository }` MUST be introduced, with transport/app signatures widened before `memoryRepository` is added to `HandlerDeps`. No ORM SHALL be added.

Source: data-model

#### Scenario: Parameterized queries

- GIVEN any repository method
- WHEN it builds SQL
- THEN user-supplied values are bound parameters only

### Requirement: Recall full-text search

`recall` MUST perform `websearch_to_tsquery('english', query)` against `content_tsv`, filtered by project (and repo when scope=repo), `status='active'` and optional `types`, ranked by `ts_rank_cd / (1 + age_days/30)` with `age_days` from `updated_at`. It MUST return `total_matches` (COUNT of the same predicate) and support keyset pagination (fetch `limit+1`, opaque `cursor` over `(rank, id)`, `cursor=null` when no further page), default `limit=8`.

Source: data-model

#### Scenario: Ranked, scoped, paginated results

- GIVEN seeded memory rows in two projects
- WHEN calling `recall` with a query and `limit`
- THEN only the caller's project's active records are returned in rank order with `total_matches` and a working cursor

#### Scenario: No matches

- GIVEN a query matching nothing
- WHEN calling `recall`
- THEN results are empty and `cursor` is null

### Requirement: get_memory

`get_memory` MUST decode the handle to `(memory_id, revision_no)`, fetch the memory row and its `memory_relation` edges (supersedes, conflicts_with, duplicate) with related handles. Revision history is not exposed (no history field in the contract). An invalid, stale or non-active handle MUST return a generic opaque error.

Source: data-model

#### Scenario: Stale handle

- GIVEN a handle whose decoded revision is behind `memory.current_revision`
- WHEN calling `get_memory`
- THEN a generic opaque error is returned

#### Scenario: Found with relations

- GIVEN an active memory with relations
- WHEN calling `get_memory` with its handle
- THEN the record and its mapped relations are returned

### Requirement: get_context

`get_context` MUST return active `constraint` and `domain_rule` records first (never budget-dropped), then recent `decision` and `gotcha` records by time-decay within the token budget. `superseded` and `deprecated` records MUST be excluded.

Source: data-model

#### Scenario: Constraints lead

- GIVEN active constraints, domain rules, decisions and gotchas
- WHEN calling `get_context`
- THEN constraints and domain rules come first, stale records are flagged, and superseded/deprecated are absent

### Requirement: Handle codec

A single util MUST provide `encodeHandle(memoryId, revisionNo)` = `base64url("<uuid>:<rev>")` and `decodeHandle`; the server is the only encoder and decoder.

Source: data-model

#### Scenario: Round trip

- GIVEN a memory id and revision
- WHEN encoding then decoding
- THEN the original values are returned

### Requirement: Tenant scoping

All queries MUST be scoped to `ctx.tenant.projectId` (and `repoId` for scope=repo). The client MUST NOT be able to widen scope via input.

Source: data-model

#### Scenario: Cross-project isolation

- GIVEN memories in another project
- WHEN reading with any input
- THEN they are never returned

### Requirement: Row-to-contract mapping and status exclusion

DB rows MUST map to the contract types: `handle` via `encodeHandle`, `stale` computed from `ttl_days`, `origin` = `{branch, pr}`, `fields` jsonb as-is. No record with `status IN ('superseded','deprecated')` SHALL be returned by any read tool. Every successful read MUST still write the `access_log` row, and all error paths MUST use the opacity path.

Source: data-model

#### Scenario: Mapping

- GIVEN an active memory row
- WHEN mapped for the response
- THEN it conforms to `MemoryRecord` with the encoded handle and computed `stale`

### Requirement: Read test coverage

An in-memory `MemoryRepository` fake (mirroring `tests/auth/fakes.ts`) MUST exist and be deterministic. Unit tests MUST cover recall (ranking, project/repo scope, type filter, pagination, empty), get_memory (found, stale, not-found, relations), get_context (ordering, stale flag, exclusions) and row mapping. Existing handler tests MUST seed the fake and stay green.

Source: data-model

#### Scenario: Suite green

- GIVEN the fake repository
- WHEN running the unit tests
- THEN they pass without a database

## History

| Requirement | Source | Superseded by |
|---|---|---|
| `recall` returns `source:"main"` only (no staging mix) | data-model | write-path (staged items tagged `source:"staged"`; see `staging`) |
| No pgvector, semantic search deferred | data-model | hybrid-search (embedding column and semantic fallback; see `hybrid-search`) |
