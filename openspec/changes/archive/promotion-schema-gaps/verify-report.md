# Verify Report — promotion-schema-gaps

schema: verify-report-v1
change: promotion-schema-gaps
date: 2026-07-30
verdict: PASS (after remediation)

## Inputs
- Static review vs spec+design (crombie-reviewer): PASS (0 CRITICAL / 0 HIGH; 1 MEDIUM, 1 LOW — both remediated).
- Run gate (worker T004): PASS — build clean, 285 tests, 66 DB-gated skipped, 0 failed, lint clean.
- Security surface: negligible — schema-only, no new tool/query writes to `quarantine` yet; quarantine rows are
  tenant-attributable (`project_id NOT NULL`), budgets enforced as CHECKs, no injection surface introduced.

## Findings (all resolved)
- **MEDIUM (fixed)** — `tests/staging/fakes.ts` omitted the two new required `StagingItemRow` fields
  (`promoted_at`/`promoted_memory_id`), leaving the fake type-unsound and returning `undefined` vs the real
  repo's `null` — would have skewed the `promotion-pipeline` idempotency tests. Fixed: both literals now set
  `null`; interface fields kept required.
- **LOW (fixed)** — the "survives staging sweep" integration test didn't seed a `staging_item` in the sweep
  session, so the cascade half wasn't exercised. Fixed: seeds an item, then asserts it cascades away while the
  quarantine snapshot survives.

## Confirmed clean
Spec REQ-01..REQ-12 satisfied (incl. OUT-of-scope: no promotion logic, no new tool, no pgvector). Migration
fully idempotent (matches 0002/0003). `ALTER TYPE ADD VALUE` is safe inside the migrator's per-file txn on
PG16 (value added, never used in the same file). FKs correct: `promoted_memory_id → memory ON DELETE SET NULL`;
quarantine `project_id`/`repo_id` FKs, NO FK to staging (sweep-safe). Quarantine self-contained snapshot +
budget CHECKs + project_id/expires_at indexes. Repository touch-up is a faithful projection with zero behavior
change; existing write-path tests untouched.

## Final gate
`pnpm build && pnpm test -- --run && pnpm lint` → build clean, 285 tests passed, 66 DB-gated skipped, 0 failed, lint clean.

## VERDICT: PASS — 0 CRITICAL / 0 HIGH. Ready to archive.
