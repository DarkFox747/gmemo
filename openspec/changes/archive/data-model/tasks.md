# Tasks — Data Model (Change B): wire read tools to real memory data

schema: tasks-v1
change: data-model

Coupled wiring with a STRICT edit-order (design.md): AppServices must be widened through
transport/app/index BEFORE memoryRepository is added to HandlerDeps. Executed in 2 waves.
All signatures/SQL/paths are fixed in design.md — workers MUST follow it verbatim.

## WAVE 1 — Group A: data layer (one worker, no wiring/handlers touched)  ✅ DONE (build+lint green)
- [x] T201 CREATE `migrations/0002_memory.sql` — `memory` (content_tsv GENERATED STORED on **english**, weights A/B/C, GIN), `memory_revision`, `memory_relation` + enums (guarded) + indexes incl. D8 composite `(project_id,status,type)` + partial `WHERE ttl_days IS NOT NULL`; idempotent, forward-only (mirror 0001). NO staging tables. (REQ-01,02,03,04)
- [x] T202 CREATE `src/db/memoryRepository.ts` — `MemoryRepository` interface + `PgMemoryRepository(pool)`: `recall` (FTS websearch_to_tsquery('english') + time-decay via updated_at + project/repo scope + type filter + status=active + keyset cursor over (rank,id), limit+1, separate COUNT for total_matches), `getMemoryByHandle` (project+active row or opaque-null + bidirectional relations join same-project+active), `getContextRecords` (phase1 constraint/domain_rule, phase2 decision/gotcha, SQL-computed stale). Parameterized ONLY. Mirror AuthRepository style. (REQ-05,06,07,08,09,16)
- [x] T203 CREATE `src/mcp/handle.ts` — `encodeHandle(memoryId, revisionNo)`=base64url("<uuid>:<rev>"), `decodeHandle`, `isHandleStale(current, decoded)`; server-only; document invariant. (REQ-10,11)
- [x] T204 CREATE `src/mcp/memoryMapper.ts` — map DB rows → `MemoryRecord`/`MemoryRelation`: handle via encodeHandle; `source:"main"`; `stale` computed; `origin={branch,pr}`; `fields` jsonb as-is; `references`=de-duped relation target handles. (REQ-15)
- [x] T205 MODIFY `src/contracts/tools.ts` (+`cursor?: string` on RecallRequest) and `src/mcp/tools/schemas.ts` (optional `cursor` in recall input). Additive — build stays green. (REQ-07)

## WAVE 2 (parallel: Group B ∥ Group C) — after Wave 1

### Group B — wiring + handler bodies (one worker; STRICT edit-order)
- [x] T220 `src/mcp/context.ts` — add `AppServices = AuthServices & { memoryRepository: MemoryRepository }`; then add `memoryRepository` to `HandlerDeps`. (REQ-13,14)
- [x] T221 `src/mcp/transport.ts` — widen `makeMcpPostHandler(services: AppServices)` (do this + T222/T223 BEFORE relying on the widened spread). (REQ-14)
- [x] T222 `src/http/app.ts` — widen `createApp(services: AppServices)`. (REQ-14)
- [x] T223 `src/index.ts` — construct `PgMemoryRepository(pool)`; assemble `AppServices` and inject. (REQ-14)
- [x] T224 `src/mcp/tools/recall.ts` — real body: `deps.memoryRepository.recall(ctx.tenant, {query,scope,types,limit,cursor})` → mapper → RecallResponse (total_matches, cursor). (REQ-06,07,12,15,18)
- [x] T225 `src/mcp/tools/getMemory.ts` — decodeHandle → `getMemoryByHandle` → mapper; invalid/stale/non-active → ONE opaque error. (REQ-08,10,11,12,18)
- [x] T226 `src/mcp/tools/getContext.ts` — `getContextRecords(ctx.tenant)` → constraint/domain_rule first (never dropped), decisions/gotchas by decay within budget, stale flagged → GetContextResponse. (REQ-09,12,15)

### Group C — tests (one worker; depends only on Wave-1 interface, follows design.md for shapes)
- [x] T240 CREATE `tests/memory/fakes.ts` — `InMemoryMemoryRepository` (seedable, deterministic), mirror tests/auth/fakes.ts. (REQ-20)
- [x] T241 CREATE `tests/memory/recall.test.ts` — ranking order, project/repo scope, type filter, pagination+cursor, empty. (REQ-21)
- [x] T242 CREATE `tests/memory/getMemory.test.ts` — found, stale-handle, not-found, relations mapped. (REQ-21)
- [x] T243 CREATE `tests/memory/getContext.test.ts` — constraint/domain_rule first, stale flag, exclusion of superseded/deprecated. (REQ-21)
- [x] T244 CREATE `tests/memory/handle.test.ts` — encode/decode round-trip, stale detection. (REQ-21)
- [x] T245 CREATE `tests/memory/mapping.test.ts` — row→contract (source:"main", budgets, origin, references). (REQ-21)
- [x] T246 CREATE `tests/db/memory.migrate.integration.test.ts` — apply 0002 + assert tables/enums/indexes; SKIP without DATABASE_URL. (REQ-23)
- [x] T247 MODIFY `tests/mcp/{recall,getMemory,getContext}.test.ts` — seed the in-memory fake into the stub services; drop the recall `source:"staged"` assertion (now source:"main"). (REQ-22)

## Finalization (verify phase)
- [x] T260 `pnpm build && pnpm test -- --run && pnpm lint` — all green (build clean, 155 pass / 23 skip,
      lint 0 err/warn). Verify PASS after remediation of the cursor HIGH + MEDIUM/LOW findings.
