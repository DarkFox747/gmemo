# Exploration — Data Model (Change B): wire read tools to real memory data

schema: exploration-synthesis-v1
change: data-model
sources: 2 crombie-explore agents (memory data model + search · read-tool handler wiring)

## Read core (3 tables)
`memory`, `memory_revision`, `memory_relation`. Auth/tenancy tables already migrated (0001).
- `memory.content_tsv`: GENERATED STORED tsvector, weights title=A/summary=B/body=C; GIN index
  `ix_memory_tsv`. Schema v2 uses **'simple'** dict; docs recommend **'english'** (all content English).
- Indexes: `ix_memory_proj_status(project_id,status)`, `ix_memory_proj_type(project_id,type)`.
- Statuses: only `active` returned; `superseded`/`deprecated` excluded.
- TTL: NO DB trigger — compute `now() > created_at + ttl_days*INTERVAL '1 day'` at query time → `stale:true`.

## recall (pilot = FTS only; pgvector deferred)
`websearch_to_tsquery(<dict>, query)` @@ content_tsv, filtered by project (+ repo if scope=repo),
status=active, optional type filter; rank = `ts_rank_cd / (1 + age_days/30)` (30d half-life on `updated_at`);
`ORDER BY rank DESC LIMIT n+1` (n+1 to emit cursor); `total_matches` = COUNT(*) of same predicate.
Staging-mix (§5, source:'staged') requires staging tables → DEFERRED with those tables.

## get_context (no query)
Phase 1 (never budget-cut): `type IN ('constraint','domain_rule') AND status='active'`.
Phase 2 (fill budget): `type IN ('decision','gotcha') AND status='active' ORDER BY updated_at DESC`, with
`stale` computed. Application applies the ~1500–2000 token budget cut between whole records.

## get_memory(handle)
Decode handle→(memory_id, revision_no); fetch memory row (error opaque if missing/non-active);
if `memory.current_revision != handle.revision` → stale reference; fetch `memory_revision` list +
`memory_relation` (from OR to) typed supersedes/conflicts_with/duplicate; resolve related titles.

## Handle
Server-only opaque construct (no DB column). Encode `base64url(memory_id:revision_no)`; stale iff
`current_revision > encoded revision_no`. MUST be defined & stable before implementing (agents hold handles).

## Handler wiring (current code)
- 3 stubs share `(input, ctx: RequestContext, _deps: HandlerDeps)`; `HandlerDeps` is an EMPTY interface
  with a "change B" placeholder comment (the declared insertion point). Rename `_deps`→`deps`.
- `ctx.tenant.{projectId,repoId,branch}` available for scoping; `ctx.actor.actorId` present.
- Response contract types in `src/contracts/{memory,tools}.ts` (MemoryRecord/RecallResponse/
  GetMemoryResponse/GetContextResponse) — DB rows map into these.
- Pattern to mirror: `AuthRepository` (interface in src/db/authRepository.ts + PgImpl(pool) + InMemory
  fake in tests/auth/fakes.ts).
- **Edit-order risk (load-bearing):** `Deps` = `HandlerDeps & AuthServices` + resolutionInput, but
  `makeMcpPostHandler(services: AuthServices)` only carries AuthServices. Adding `memoryRepository` to
  HandlerDeps breaks the spread until the services type + transport/app signatures are WIDENED first.
- Migration runner (src/db/migrate.ts) conventions: forward-only, `schema_migrations` ledger (bare
  version), BEGIN/COMMIT per file, idempotent (CREATE ... IF NOT EXISTS + DO-block enum guards).
  A `migrations/0002_*.sql` drops in and runs after 0001 by lexical order.

## Edit points (file-by-file)
1. CREATE `src/db/memoryRepository.ts` (interface + PgMemoryRepository(pool), parameterized).
2. CREATE `migrations/0002_memory.sql` (memory + memory_revision + memory_relation; NOT staging).
3. CREATE `src/mcp/handle.ts` (encode/decode + stale check) — or colocate in repo.
4. EDIT `src/mcp/context.ts` (HandlerDeps gains memoryRepository; introduce combined services type).
5. EDIT `src/mcp/transport.ts` (widen makeMcpPostHandler services type FIRST).
6. EDIT `src/http/app.ts` (thread widened services).
7. EDIT `src/index.ts` (construct PgMemoryRepository(pool), inject).
8. EDIT `src/mcp/tools/{recall,getMemory,getContext}.ts` (replace stub bodies; map rows→contracts).
9. TESTS: `tests/memory/fakes.ts` (InMemoryMemoryRepository) + unit tests; update existing handler tests
   (tests/mcp/*) that pass `{}`/stub deps to seed the fake; 0002 migration integration test (skip w/o DATABASE_URL).

## Open decisions (surfaced to proposal — I will decide these)
1. FTS dictionary: **'simple' vs 'english'** — pilot-blocker; must be set BEFORE data is written.
2. Combined services type: add memoryRepository to AuthServices vs a new `AppServices` (AuthServices & {memoryRepository}).
3. Handle encoding format (base64url `memory_id:revision_no`).
4. Time-decay signal (`updated_at` vs created_at/reviewed_at) + half-life; 'recent' window for get_context.
5. Pagination: keyset cursor (rank,id) vs offset.
6. Migrate staging tables now or defer.
7. Composite index (project_id, status, type) for get_context phase 1.

## Risks
- Changing FTS dict after data load requires rebuilding all tsvectors → decide up front.
- pgvector deferred → recall misses paraphrase/semantic matches (acceptable for pilot; note it).
- TTL has no index; a partial index on `WHERE ttl_days IS NOT NULL` helps get_context's stale scan at scale.
- Handle format is a hard, stable contract once agents hold handles.
- Transport-widening edit order (above) is the top integration risk.
- Existing handler tests break once HandlerDeps is non-empty unless seeded with the fake.
