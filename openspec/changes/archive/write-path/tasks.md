# Tasks — write-path (write-to-staging slice)

schema: tasks-v1
change: write-path
status: READY
date: 2026-07-30

Each task maps to REQ ids (specs/write-path.md) and design.md's File Changes table.
Batch letters mark file-independence for parallel apply workers.

## Batch A — foundations (independent files, fully parallel)

- [x] **T001** Create `migrations/0003_staging.sql` — guarded enums (staging_status,
  judge_state, staging_op), `staging_session` + `ux_session_open` (partial, WHERE
  status='open') + `ix_session_status`, `staging_item` with NOT NULL title/summary,
  op↔target CHECK, budget CHECKs (120/200/2000), `UNIQUE(session_id,content_hash)`,
  `ix_item_session`/`ix_item_judge`. Idempotent, no Cognito coupling. [REQ-01..06]
- [x] **T002** Create `src/db/ulid.ts` — inline `ulid()` (Crockford base32, `node:crypto`, 26 chars, no dep). [REQ-02]
- [x] **T003** Create `src/security/secretScan.ts` — `scanForSecrets` + `assertNoSecrets`
  (AWS AKIA/ASIA, PEM private keys, JWTs, gh/slack/google/stripe/openai tokens, high-entropy
  heuristic); fail-closed → `PERMISSION_DENIED`; log category names only, never matched text. [REQ-21]
- [x] **T004** Create `src/mcp/fieldsPolicy.ts` — per-type allowed-key map (7 types) +
  `assertValidFields(type, fields)` → `INVALID_REFERENCE` on unknown key; empty/absent OK. [REQ-12]
- [x] **T005** Modify `src/contracts/tools.ts` — add `RememberRequest`/`RememberResponse`/`RememberResult`,
  `StagedItemView`/`ListStagedResponse`, `DiscardStagedRequest`/`DiscardStagedResponse`. [REQ-07,14,15]
- [x] **T006** Modify `src/mcp/tools/schemas.ts` — add `STAGING_OPS` + `rememberInputShape`,
  `listStagedInputShape`, `discardStagedInputShape` (budgets mirror DB CHECKs). [REQ-07,11]

## Batch B — injection + shared seams (touches context.ts & auth; run after A)

- [x] **T007** Modify `src/mcp/context.ts` — the 4 widening points: import `StagingRepository`;
  widen `ToolName` (+remember/list_staged/discard_staged); add `AuditLogger.recordWrite(ctx,
  sessionId,itemId,contentHash)`; add `stagingRepository` to `HandlerDeps` AND `AppServices`. [REQ-18]
- [x] **T008** Modify `src/auth/authorizer.ts` — enforce `WRITE_TOOLS`→`WRITE_ROLES`
  ({project_admin,contributor,service_agent}); viewer → `PERMISSION_DENIED`, opaque. Atomic
  with T007's ToolName widening. [REQ-18,19]
- [x] **T009** Modify `src/auth/auditLogger.ts` — implement `recordWrite` inserting
  `access_log` `action:'stage'`, actor identity, `query_hash=contentHash`, detail
  {tool,repoId,branch,itemId}; no raw content. [REQ-20]

## Batch C — repository (after B; own file)

- [x] **T010** Create `src/db/stagingRepository.ts` — `StagingRepository` interface +
  `PgStagingRepository`: `findOrCreateOpenSession` (upsert ON CONFLICT ... WHERE status='open'
  DO NOTHING + reselect + TTL bump), `insertStagingItem` (idempotent dedup + reselect),
  `listStagingItems` (join-scoped), `discardStagingItem` (tenant-scoped delete). All parameterized,
  `project_id=$N` scoped. [REQ-08,13,17,23]

## Batch D — handlers + mapper (after C; each its own new file, D-mapper modifies memoryMapper)

- [x] **T011** Create `src/mcp/tools/remember.ts` — `rememberHandler` 8-step algorithm
  (assertValidFields → op↔target → target resolve+stale→uncertain → secret-scan →
  content_hash → findOrCreateOpenSession → insertStagingItem → return {id,state,sessionId,contentHash}). [REQ-07..13,21]
- [x] **T012** Create `src/mcp/tools/listStaged.ts` — `listStagedHandler` → `{items}` via `toStagedItemView`. [REQ-14]
- [x] **T013** Create `src/mcp/tools/discardStaged.ts` — `discardStagedHandler`; not-found → `INVALID_REFERENCE`. [REQ-15]
- [x] **T014** Modify `src/mcp/memoryMapper.ts` — add `toStagedRecord(item, branch)`
  (`source:'staged'`, handle=encodeHandle(id,1)); `toMemoryRecord` unchanged. [REQ-16]

## Batch E — wiring (after D; separate files, parallel)

- [x] **T015** Modify `src/mcp/tools/index.ts` — add `registerWriteTools(server, deps)`
  (destructure-and-reassemble; 6-step chain; remember audits AFTER handler). [REQ-07,18,20]
- [x] **T016** Modify `src/mcp/tools/recall.ts` — first-page-only staged-mix
  (`source:"staged"` prepended; total_matches=main; cursor pages skip staged fetch). [REQ-16,17]
- [x] **T017** Modify `src/mcp/server.ts` — call `registerWriteTools(server, deps)`. [REQ-07]
- [x] **T018** Modify `src/index.ts` — instantiate `new PgStagingRepository(pool)`; add to `services`. [REQ-08]

## Batch F — tests (after E; every file independent, high parallelism)

- [x] **T019** Create `tests/staging/fakes.ts` — `InMemoryStagingRepository` (mirror tests/memory/fakes.ts). [REQ-25]
- [x] **T020** Create `tests/staging/remember.test.ts` — add/amend fresh/amend stale→uncertain/
  bad target/op↔target/dedup/unknown-field/secret-scan-fail-closed. [REQ-25]
- [x] **T021** Create `tests/staging/listStaged.test.ts` — own-session items; empty session. [REQ-25]
- [x] **T022** Create `tests/staging/discardStaged.test.ts` — own item ok; unknown/other-session → INVALID_REFERENCE. [REQ-25]
- [x] **T023** Create `tests/staging/recallMix.test.ts` — first page prepends staged; cursor page none; no session unchanged. [REQ-16,25]
- [x] **T024** Create `tests/security/secretScan.test.ts` — each category positive; clean prose clean; assertNoSecrets throws PERMISSION_DENIED, logs categories only. [REQ-21,25]
- [x] **T025** Create `tests/mcp/fieldsPolicy.test.ts` — allowed subset/empty pass; unknown key → INVALID_REFERENCE. [REQ-12,25]
- [x] **T026** Create `tests/db/ulid.test.ts` — 26-char Crockford, uniqueness, timestamp-prefixed ordering. [REQ-25]
- [x] **T027** Create `tests/db/staging.migrate.integration.test.ts` (DB-gated) — schema/enums/indexes;
  reject op mismatch, NULL title/summary, over-budget, second open session, dup content_hash. [REQ-26]
- [x] **T028** Create `tests/db/stagingRepository.integration.test.ts` (DB-gated) — upsert race same id;
  dedup one row; list/discard tenant-scoped. [REQ-26]
- [x] **T029** Modify `tests/mcp/registration.test.ts` — expect SIX tools; assert remember/discard_staged schemas. [REQ-24]
- [x] **T030** Modify `tests/auth/authorizer.test.ts` — write-role matrix (viewer denied; contributor/service_agent/project_admin allowed). [REQ-18,19]
- [x] **T031** Modify `tests/auth/auditLogger.test.ts` — recordWrite row shape (action:'stage', session_id, query_hash). [REQ-20]
- [x] **T032** Modify `tests/mcp/recall.test.ts` + `tests/memory/recall.test.ts` — provide empty staging dep so existing assertions hold. [REQ-16]

## Batch G — gate (after F; single sequential)

- [x] **T033** Run `pnpm build && pnpm test -- --run && pnpm lint` — all green; fix any fallout. [REQ-27]

## Dependency notes
- A → B → C → D → E → F → G (type/interface dependencies flow downhill).
- Within a batch, tasks touch disjoint files and run in parallel.
- B is small but MUST precede C/D (they import the widened context types).
- T007+T008 are the atomic RBAC pair (widen + enforce together — no viewer-write hole).
