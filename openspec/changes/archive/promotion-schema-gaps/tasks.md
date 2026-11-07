# Tasks — promotion-schema-gaps

schema: tasks-v1
change: promotion-schema-gaps
status: READY
date: 2026-07-30

Small schema-only change. The migration + repository type touch-up land together (atomic build
green). Single batch, one worker (tightly coupled; not worth parallelizing).

## Batch A — schema + types + test (one worker, sequential)

- [x] **T001** Create `migrations/0004_promotion_gaps.sql` (idempotent, numbered like 0002/0003):
  `ADD COLUMN IF NOT EXISTS` for `staging_item.promoted_at timestamptz` and
  `staging_item.promoted_memory_id uuid` + FK → `memory(id) ON DELETE SET NULL`;
  `ALTER TYPE staging_status ADD VALUE IF NOT EXISTS 'partially_promoted'` (added, not referenced);
  `CREATE TABLE IF NOT EXISTS quarantine` (self-contained snapshot per design: content cols,
  budget CHECKs, project_id/repo_id FKs, origin_session_id/origin_item_id breadcrumbs NO FK,
  quarantined_at default now(), nullable expires_at) + indexes on project_id and expires_at.
  Copy the exact DDL from design.md. [REQ-01..06]
- [x] **T002** Modify `src/db/stagingRepository.ts` — add the two new nullable fields to
  `StagingItemRow` and extend the `LIST_STAGING_ITEMS_SQL` SELECT projection accordingly. No new
  queries. No behavior change. [REQ-07,08]
- [x] **T003** Create `tests/db/promotionGaps.migrate.integration.test.ts` (DB-gated, `describe.skip`
  without DATABASE_URL, mirroring `staging.migrate.integration.test.ts`): assert the two new columns
  + FK, the `partially_promoted` enum value, the `quarantine` table + columns/CHECKs/indexes/FKs,
  a snapshot survives deletion of its origin staging_item row, and re-applying 0004 is a no-op. [REQ-09]
- [x] **T004** Run `pnpm build && pnpm test -- --run && pnpm lint` — all green; existing 285 tests
  stay passing. [REQ-10]

## Notes
- YAGNI guard (REQ-11/12): NO promotion logic, NO new tool, NO pgvector — schema groundwork only.
