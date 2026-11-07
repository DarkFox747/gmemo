# Spec — Data Model (Change B): wire read tools to real memory data

schema: spec-v1
change: data-model
status: draft

## Overview

Land the memory READ tables (`memory`, `memory_revision`, `memory_relation`) and a
`MemoryRepository`, then replace the three read-tool stubs (`recall`, `get_memory`,
`get_context`) with real, project-scoped RDS queries mapped to the existing contract types.
Staging tables and the write path are deferred; `recall` returns `source:"main"` only.

## Requirements

### Migration & schema
- **REQ-01** `migrations/0002_memory.sql` MUST create `memory`, `memory_revision`, `memory_relation`
  and their enums, faithful to schema v2, forward-only and idempotent (mirror 0001 style). It MUST NOT
  create staging tables.
- **REQ-02** `memory.content_tsv` MUST be a GENERATED STORED tsvector using the **`english`** dictionary
  with weights title=A, summary=B, body=C, plus a GIN index. (Resolves the FTS `simple`→`english` decision.)
- **REQ-03** Indexes MUST include a composite `(project_id, status, type)` and a partial index
  `WHERE ttl_days IS NOT NULL`; existing schema-v2 indexes preserved.
- **REQ-04** Content budgets (title≤120, summary≤200, body≤2000) MUST remain enforced as DB CHECK constraints.

### MemoryRepository
- **REQ-05** A `MemoryRepository` interface + `PgMemoryRepository` (pg Pool in constructor) MUST be added,
  mirroring the `AuthRepository` pattern. ALL SQL MUST be parameterized (no concatenation of query/scope/branch).
- **REQ-06** `recall` MUST perform FTS (`websearch_to_tsquery('english', query)` @@ `content_tsv`), filtered by
  project (and repo when scope=repo), `status='active'`, and optional `types`; ranked by
  `ts_rank_cd / (1 + age_days/30)` with `age_days` from `updated_at`.
- **REQ-07** `recall` MUST return `total_matches` (COUNT of the same predicate) and support keyset pagination
  (fetch `limit+1`; emit an opaque `cursor` over `(rank, id)`; `cursor=null` when no further page). Default `limit=8`.
- **REQ-08** `get_memory` MUST decode the handle to `(memory_id, revision_no)`, fetch the memory row, its
  `memory_revision` list, and `memory_relation` edges (supersedes/conflicts_with/duplicate) with related handles.
- **REQ-09** `get_context` MUST return active `constraint` + `domain_rule` records FIRST (never budget-dropped),
  then recent `decision`/`gotcha` by time-decay within the token budget; `superseded`/`deprecated` excluded.

### Handle
- **REQ-10** A single util MUST `encodeHandle(memoryId, revisionNo)` = `base64url("<uuid>:<rev>")` and
  `decodeHandle`; the server is the only encoder/decoder.
- **REQ-11** A handle whose decoded revision is behind `memory.current_revision` MUST be treated as stale;
  `get_memory` on an invalid/stale/non-active handle MUST return a generic opaque error (no enumeration).

### Handler wiring & scoping
- **REQ-12** All queries MUST be scoped to `ctx.tenant.projectId` (and `repoId` for scope=repo); the client
  MUST NOT be able to widen scope via input.
- **REQ-13** Handler signatures `(input, ctx, deps)` MUST NOT be reshaped; the repository is injected via `deps`.
- **REQ-14** A combined `AppServices = AuthServices & { memoryRepository }` MUST be introduced; the
  transport/app signatures MUST be widened to `AppServices` BEFORE `memoryRepository` is added to `HandlerDeps`
  (edit-order requirement). `PgMemoryRepository(pool)` MUST be constructed once at boot and injected.

### Mapping & semantics
- **REQ-15** DB rows MUST map to the existing contract types (`MemoryRecord`/`RecallResponse`/
  `GetMemoryResponse`/`GetContextResponse`): `handle` via encodeHandle; `source` hardcoded `"main"`;
  `stale` computed (`now() > created_at + ttl_days*INTERVAL '1 day'`); `origin` = `{branch, pr}`; `fields` jsonb as-is.
- **REQ-16** No record with `status IN ('superseded','deprecated')` is ever returned by any read tool.
- **REQ-17** Every successful read MUST still write the `access_log` row (server-side `query_hash`) via the
  existing audit seam — auth/audit behavior from change C MUST remain intact.

### Error opacity & security
- **REQ-18** All error paths MUST route through the existing opacity path (no stack/DB detail/tenant enumeration).
- **REQ-19** No new runtime dependency; no pgvector, no ORM, no staging tables.

### Testing
- **REQ-20** An in-memory `MemoryRepository` fake MUST exist (mirror `tests/auth/fakes.ts`), seedable and
  deterministic.
- **REQ-21** Unit tests MUST cover: recall (ranking order, project/repo scope, type filter, pagination+cursor,
  empty result); get_memory (found, stale-handle, not-found, relations mapped); get_context (constraint/domain_rule
  first, stale flag, exclusion of superseded/deprecated); row→contract mapping (`source:"main"`, budgets, origin).
- **REQ-22** Existing handler tests (`tests/mcp/*`) MUST be updated to seed the fake and stay green.
- **REQ-23** A `0002` migration integration test MUST run the migration and assert tables/enums/indexes exist,
  and MUST SKIP cleanly when `DATABASE_URL` is unset.
- **REQ-24** `pnpm build && pnpm test -- --run && pnpm lint` MUST be green (0 lint errors/warnings).

## Acceptance Criteria
- With seeded memory rows, `recall` returns ranked project-scoped active records with `total_matches` and a
  working cursor; `get_context` leads with constraints/domain_rules and flags stale; `get_memory` returns a
  record + its relations, and a stale/invalid handle yields a generic opaque error.
- No staging code, no pgvector, no write tools present; `recall` results are all `source:"main"`.
- Auth/RBAC/audit from change C still enforced on every read.
- Full pnpm build/test/lint green.

## Out of Scope (traceability)
staging_session/staging_item + recall staging-mix (source:"staged") · write tools + promotion/judge/quarantine ·
pgvector semantic search · graph Layer 2 tools · real data seeding (dev-harness/write-path).
