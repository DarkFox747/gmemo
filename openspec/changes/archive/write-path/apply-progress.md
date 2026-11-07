# Apply Progress — write-path

schema: apply-progress-v1
change: write-path
updated: 2026-07-30

## Batch A — foundations ✅ (2026-07-30)
Workers: 3 parallel. Status: SUCCESS. Gate: build + lint + 163 tests green (DB integration skipped).
- [x] T001 migrations/0003_staging.sql
- [x] T002 src/db/ulid.ts
- [x] T003 src/security/secretScan.ts
- [x] T004 src/mcp/fieldsPolicy.ts
- [x] T005 src/contracts/tools.ts (+7 write contracts)
- [x] T006 src/mcp/tools/schemas.ts (+STAGING_OPS +3 shapes)
Files: migrations/0003_staging.sql, src/db/ulid.ts, src/security/secretScan.ts,
src/mcp/fieldsPolicy.ts, src/contracts/tools.ts, src/mcp/tools/schemas.ts
Deviations: none.

## Batch B — injection + RBAC + audit ✅ (2026-07-30)
Worker: 1 (sequential T007→T008→T009; atomic RBAC pair). Status: SUCCESS. Gate: build + lint + 163 tests green.
- [x] T007 src/mcp/context.ts (4 widening points + AuditLogger.recordWrite); also created StagingRepository INTERFACE in src/db/stagingRepository.ts (impl deferred to C)
- [x] T008 src/auth/authorizer.ts (WRITE_TOOLS→WRITE_ROLES; viewer denied)
- [x] T009 src/auth/auditLogger.ts (recordWrite action:'stage')
Files: src/db/stagingRepository.ts (interface only), src/mcp/context.ts, src/auth/authorizer.ts,
src/auth/auditLogger.ts, src/index.ts (stub), tests/auth/fakes.ts (stub)
Deviations (build-green stubs to finalize later):
- src/index.ts: `stagingRepository = {} as StagingRepository` → Batch E/T018 replaces with `new PgStagingRepository(pool)`.
- tests/auth/fakes.ts: `stubStagingRepository = {} as StagingRepository` → Batch F replaces with InMemoryStagingRepository.
- tests/mcp/{recall,getMemory,getContext}.test.ts use `as HandlerDeps` omitting stagingRepository → Batch F wires real fake.

## Batch C — repository ✅ (2026-07-30)
Worker: 1. Status: SUCCESS. Gate: build + lint + 163 tests green.
- [x] T010 src/db/stagingRepository.ts (+PgStagingRepository: findOrCreateOpenSession upsert+reselect+TTL, insertStagingItem dedup, listStagingItems join-scoped, discardStagingItem)
Deviations: none.

## Batch D — handlers + mapper ✅ (2026-07-30)
Workers: 3 parallel. Status: SUCCESS. Gate: build + lint + 163 tests green.
- [x] T011 src/mcp/tools/remember.ts (8-step: fields→op/target→stale→uncertain→secret-scan→hash→session→insert)
- [x] T012 src/mcp/tools/listStaged.ts
- [x] T013 src/mcp/tools/discardStaged.ts (opaque INVALID_REFERENCE on not-found)
- [x] T014 src/mcp/memoryMapper.ts (+toStagedRecord; MemorySource union already had 'staged')
Deviations: none.

## Batch E — wiring ✅ (2026-07-30)
Workers: 3 parallel. Status: SUCCESS. Gate: build + lint + 165 tests green.
- [x] T015 src/mcp/tools/index.ts (+registerWriteTools; remember audits AFTER handler)
- [x] T017 src/mcp/server.ts (call registerWriteTools)
- [x] T016 src/mcp/tools/recall.ts (first-page staged-mix, source:'staged')
- [x] T018 src/index.ts (stub → new PgStagingRepository(pool))
Batch F work already landed by E workers:
- [x] T029 tests/mcp/registration.test.ts (expects 6 tools + remember/discard_staged schema asserts) — done by E1.
- [x] T032 tests/{mcp,memory}/recall.test.ts + tests/auth/fakes.ts (empty staging dep) — done by E2.
Deviations: T019 still needs a SEEDABLE InMemoryStagingRepository (tests/staging/fakes.ts) for write-handler tests; E2 only added an empty-returning stub in tests/auth/fakes.ts.

## Batch F — tests ✅ (2026-07-30)
Workers: 4 parallel. Status: SUCCESS (per-worker gates green; consolidated gate = Batch G/T033).
- [x] T019 tests/staging/fakes.ts (seedable InMemoryStagingRepository + insertedItemCount)
- [x] T020 tests/staging/remember.test.ts (add/amend fresh/stale→uncertain/bad target/op↔target/dedup/unknown-field/secret-scan-nothing-persisted)
- [x] T021 tests/staging/listStaged.test.ts
- [x] T022 tests/staging/discardStaged.test.ts
- [x] T023 tests/staging/recallMix.test.ts
- [x] T024 tests/security/secretScan.test.ts (per-category + logger spy category-only)
- [x] T025 tests/mcp/fieldsPolicy.test.ts
- [x] T026 tests/db/ulid.test.ts
- [x] T027 tests/db/staging.migrate.integration.test.ts (DB-gated; 9 constraint rejections)
- [x] T028 tests/db/stagingRepository.integration.test.ts (DB-gated; upsert race, dedup, scoping)
- [x] T030 tests/auth/authorizer.test.ts (write-role matrix: viewer denied; contributor/service_agent/project_admin allowed)
- [x] T031 tests/auth/auditLogger.test.ts (recordWrite row shape)
Deviations: none. Note: concurrent workers reported differing suite totals — T033 runs the single consolidated gate.

## Batch G — consolidated gate ✅ (2026-07-30)
Worker: 1. Status: SUCCESS.
- [x] T033 `pnpm build && pnpm test -- --run && pnpm lint`
Result: build clean; 277 tests passed, 49 DB-gated skipped (no DATABASE_URL, expected), 0 failed; lint clean. No source edits needed.

## APPLY COMPLETE — 33/33 tasks. Ready for verify.
