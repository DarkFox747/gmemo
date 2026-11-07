# Apply Progress — promotion-schema-gaps

schema: apply-progress-v1
change: promotion-schema-gaps
updated: 2026-07-30

## Batch A — schema + types + test ✅
Worker: 1 (sequential T001→T004). Status: SUCCESS. Gate: build + lint + 285 tests green (66 DB-gated skipped).
- [x] T001 migrations/0004_promotion_gaps.sql (promoted_at/promoted_memory_id + FK SET NULL; staging_status += partially_promoted; quarantine table self-contained + CHECKs + FKs + indexes; idempotent)
- [x] T002 src/db/stagingRepository.ts (StagingItemRow + RawStagingItemRow + LIST_STAGING_ITEMS_SQL projection; no new queries, no behavior change)
- [x] T003 tests/db/promotionGaps.migrate.integration.test.ts (DB-gated; 11 assertions)
- [x] T004 consolidated gate green

## Post-verify remediation ✅
Worker: 1. Status: SUCCESS. Gate green.
- [x] MED-fake tests/staging/fakes.ts (added promoted_at:null / promoted_memory_id:null to both StagingItemRow literals — type-sound, null not undefined)
- [x] LOW-sweep tests/db/promotionGaps.migrate.integration.test.ts (seed a staging_item in the sweep session → assert item cascades away AND quarantine snapshot survives)

## COMPLETE — verify PASS. Ready to archive.
