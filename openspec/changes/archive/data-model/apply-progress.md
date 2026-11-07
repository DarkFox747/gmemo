# Apply Progress — Data Model (Change B)

schema: apply-progress-v1
change: data-model
mode: automatic

## Wave 1 — Group A: data layer (one worker)
T201–T205: `migrations/0002_memory.sql` (memory + memory_revision + memory_relation; content_tsv on
**english** per D2; D8 composite + partial ttl indexes; idempotent; NO staging tables),
`src/db/memoryRepository.ts` (interface + PgMemoryRepository — recall FTS+time-decay+keyset, getMemoryByHandle,
getContextRecords; parameterized), `src/mcp/handle.ts` (encode/decode + isHandleStale), `src/mcp/memoryMapper.ts`
(row→MemoryRecord, source:"main", stale, origin, references), `cursor?` added to RecallRequest + recall schema.
Verified: build ✓ + lint ✓ (additive; handlers still stubs).

## Wave 2 (parallel: Group B ∥ Group C)
- Group B (T220–T226): AppServices = AuthServices & { memoryRepository }; HandlerDeps gains memoryRepository;
  transport/app/index widened to AppServices (edit-order respected); PgMemoryRepository constructed at boot;
  the 3 handler bodies replaced with real repository calls + memoryMapper. Verified: build ✓ (0 TS errors).
- Group C (T240–T247): tests/memory/{fakes,recall,getMemory,getContext,handle,mapping}.test.ts +
  tests/db/memory.migrate.integration.test.ts (skips w/o DATABASE_URL); updated tests/auth/fakes.ts
  (makeStubAuthServices now includes memoryRepository → cascades to health/registration) + tests/mcp/*
  (seed fake, drop source:"staged"). Verified: **153 pass / 23 skip**, lint ✓.

## Deviations / notes
- get_memory does NOT query memory_revision (no history field in GetMemoryResponse — YAGNI).
- references derived from relation target handles (no extra query/body parsing).
- staging_op enum still created (memory_revision.op needs it); staging TABLES deferred (D1).
- recall returns source:"main" only (staging-mix deferred with staging tables).

## Verify remediation batch (1 worker)
Fixed HIGH cursor-forwarding (tools/index.ts) + transport-level pagination test; types:[] normalized
(prod/fake aligned); integration test idempotent teardown + index assertions (REQ-23); createPool
enforceSSL param (no process.env); dead try-catch removed; cursor Number+isFinite. Re-verified:
build ✓ · 155 pass / 23 skip · lint 0 err/0 warn.

## Status: COMPLETE — verify PASS, archived. Deferred: rate-limit + helmet (need deps), REQ-08 wording
## (accepted D9 deviation) — tracked in openspec/backlog.md.
