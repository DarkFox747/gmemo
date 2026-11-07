# Proposal — Data Model (Change B): wire read tools to real memory data

schema: proposal-v1
change: data-model
status: draft
author: sdd-orchestrator
depends_on: auth-two-gate (archived), scaffold-runtime-mcp-facade (archived)

## Problem / Motivation

The three MCP read tools (`recall`, `get_memory`, `get_context`) still return placeholder
stubs. This change lands the memory READ tables and a `MemoryRepository`, then wires the
handlers to real, project-scoped RDS data — so the facade returns actual memory instead of
stubs. It reuses the DB layer + repository pattern established by auth-two-gate.

## Chosen Approach

Mirror the `AuthRepository` pattern: a `MemoryRepository` interface + `PgMemoryRepository`
(parameterized queries) + an in-memory fake for tests. Add migration `0002_memory.sql` for
the three read tables. Replace each stub handler body with a repository call, mapping DB rows
to the existing `src/contracts` response types. Queries are scoped by the already-resolved
`ctx.tenant` (project/repo) — the client never passes tenant IDs.

### Scoping decisions I am making (flag me to change any)

- **D1 — Migrate only the READ core now:** `memory`, `memory_revision`, `memory_relation`.
  DEFER `staging_session`/`staging_item` to the write-path change. Consequence: `recall`
  returns `source:"main"` only (no staging-mix) in this change — valid for a read-only pilot.
- **D2 — FTS dictionary = `english`** (resolves the pilot-blocker open decision). All content is
  English; `english` gives stemming. MUST be set before any data is written (changing later
  requires rebuilding all tsvectors). Both the generated `content_tsv` and `websearch_to_tsquery`
  use `english`.
- **D3 — Handle encoding = `base64url("<memory_id>:<revision_no>")`**, server-only, in a single
  `encodeHandle`/`decodeHandle` util. Stale iff `memory.current_revision > decoded revision_no`.
- **D4 — recall ranking (pilot, FTS-only):** `rank = ts_rank_cd(content_tsv, q) / (1 + age_days/30)`
  where `age_days` is derived from **`updated_at`** (30-day half-life). pgvector semantic search stays
  deferred; responses note semantic search is not active.
- **D5 — recall pagination = keyset cursor** over `(rank, id)` (not offset); fetch `limit+1` to detect
  the next page; `total_matches` from a COUNT of the same predicate.
- **D6 — get_context "recent" = top-N by time-decay within the token budget** (no fixed time window);
  constraints + domain_rules always first and never budget-dropped; TTL-expired-but-active flagged `stale`.
- **D7 — Combined services type `AppServices = AuthServices & { memoryRepository }`** (NOT overloading
  AuthServices). Widen `makeMcpPostHandler`/`createApp` to `AppServices` **before** adding
  `memoryRepository` to `HandlerDeps` (the load-bearing edit-order fix).
- **D8 — Add a composite index `(project_id, status, type)`** to `memory` to serve get_context phase 1
  and recall's status/type filters efficiently; keep a partial index `WHERE ttl_days IS NOT NULL` for
  the stale scan.

## Scope

### IN scope
- `migrations/0002_memory.sql`: `memory` (with `content_tsv` on `english` + GIN), `memory_revision`,
  `memory_relation`; enums + indexes (incl. D8); idempotent, forward-only (mirrors 0001).
- `src/db/memoryRepository.ts`: `MemoryRepository` interface + `PgMemoryRepository`:
  - `recall(tenant, {query, scope, types, limit, cursor})` → rows + total_matches + next cursor
  - `getMemoryByHandle(tenant, memoryId, revisionNo)` → memory + revisions + relations (+ related titles)
  - `getContextRecords(tenant)` → constraint/domain_rule first, then decisions/gotchas, with stale flag
- `src/mcp/handle.ts`: `encodeHandle`/`decodeHandle` + stale detection.
- Wire `recall`/`getMemory`/`getContext` handlers to the repo; map rows → contract types (`source:"main"`).
- `AppServices` type; widen transport/app/index injection; construct `PgMemoryRepository(pool)` at boot.
- Tests: `tests/memory/fakes.ts` (in-memory repo) + unit tests (recall ranking/scope/type/pagination/empty;
  get_memory found/stale-handle/not-found/relations; get_context ordering + stale; row→contract mapping);
  update existing handler tests to seed the fake; `0002` migration integration test (skips w/o DATABASE_URL).

### OUT of scope (deferred)
- `staging_session`/`staging_item` tables + recall staging-mix (`source:"staged"`) → write-path change.
- Write tools (`remember`/`list_staged`/`discard_staged`), promotion pipeline, judge, quarantine.
- pgvector semantic search (recall stays FTS-only).
- Graph tools (Layer 2).
- Real memory data seeding (that is the dev-harness / write-path concern).

## Affected Areas

| Area | What changes | New/Modified |
|------|--------------|--------------|
| Migration | 0002_memory.sql (3 read tables + indexes) | New |
| MemoryRepository | interface + PgMemoryRepository | New |
| Handle util | encode/decode + stale detection | New |
| recall handler | FTS + time-decay + scope/type + pagination | Modified |
| get_memory handler | handle decode + relations + stale | Modified |
| get_context handler | priority ordering + budget + stale | Modified |
| Services wiring | AppServices + transport/app/index widening | Modified |
| Tests | in-memory fake + unit + integration + existing-test seeding | New/Modified |

_8 affected areas → NOT simple; design phase runs._

## Constraints
- Parameterized SQL only; the `branch`/`query`/`scope` values must never be concatenated into SQL.
- Error opacity preserved (invalid/stale handle → generic "handle inválido o vencido"-class opaque error;
  no enumeration of other projects' memory).
- All queries scoped to `ctx.tenant.projectId` (and repoId for scope=repo); never trust client tenant input.
- Handler signatures `(input, ctx, deps)` NOT reshaped.
- Content budgets (title≤120/summary≤200/body≤2000) already DB-enforced by the DDL — preserve.
- YAGNI: no new runtime deps (pg already present); no pgvector, no ORM.

## Open Decisions Touched
- D2 resolves the FTS `english`-vs-`simple` pilot blocker (confirm before real data loads).
- Staging deferral (D1) leaves the staging-mix (§5) for the write-path change.

## Rejected Alternatives
- Migrating staging tables now — unused without the write path; premature coupling to the
  promotion pipeline (which still has known schema gaps). Rejected (D1).
- Overloading `AuthServices` with the memory repo — conflates auth and data seams. Rejected (D7).
- Offset pagination — fragile under live data. Rejected in favor of keyset (D5).
- Keeping FTS `simple` — worse recall for English content, and the switch is expensive post-load. Rejected (D2).

## Risks
- FTS dict change (D2) must precede any data; documented as a hard pre-condition.
- Transport-widening edit order (D7) is the top integration risk — design sequences it first.
- Existing handler tests break once `HandlerDeps` is non-empty unless seeded with the fake.
- recall quality is limited without pgvector (pilot-acceptable; surfaced in responses/docs).

## Next Phases
specs ∥ design → tasks → apply → verify → archive.
