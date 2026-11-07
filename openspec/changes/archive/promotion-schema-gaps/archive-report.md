# Archive Report — promotion-schema-gaps

schema: archive-report-v1
change: promotion-schema-gaps
status: CLOSED
verdict: PASS
archived_at: 2026-07-30

## Outcome
The schema now supports the promotion pipeline without any future migration on a populated
`staging_item` table. Migration `0004_promotion_gaps.sql` closes the three gaps; no behavior
changed. This is pure groundwork — all promotion LOGIC lands in the next change.

## Pipeline
proposal (inline) → design (architect) → specs + tasks (inline) → apply (1 worker) →
verify (reviewer) → remediation (1 worker) → archive (inline).

## What shipped
- `staging_item.promoted_at` + `staging_item.promoted_memory_id` (FK → memory, ON DELETE SET NULL)
  — per-item idempotency (`promoted_at IS NULL` first-writer-wins).
- `staging_status` enum += `partially_promoted`.
- `quarantine` table — self-contained snapshot (content + provenance breadcrumbs), tenant-attributable
  (`project_id`), budget CHECKs, `quarantined_at` + nullable `expires_at`, indexes on project_id/expires_at.
  NO FK to staging (a TTL sweep cannot orphan it).
- `StagingItemRow` + `LIST_STAGING_ITEMS_SQL` extended with the two nullable columns (faithful projection).
- DB-gated integration test (11 assertions incl. cascade-vs-quarantine-survival + idempotent re-apply).

## Requirements
REQ-01..REQ-12 satisfied. 285 tests green (66 DB-gated skipped without DATABASE_URL); build + lint clean.

## Key decisions
- Quarantine = separate self-contained table (not a staging_item terminal state) → sweep-safe terminal audit sink.
- `promoted_memory_id` ON DELETE SET NULL (idempotency rides on `promoted_at`, not the pointer).
- `ADD VALUE IF NOT EXISTS` safe inside the migrator's per-file transaction on PG16 (added, not used).
- Retention (1 vs 2 months) is OPERATIONAL policy for a future sweep job — NOT in the DDL. **Still open.**

## Deferred → next changes
- **promotion-pipeline** (next): `POST /promote` + GitHub Action OIDC + sanitize → Bedrock judge (3-state,
  fail-closed) → idempotent apply / quarantine-write / partially_promoted; + quarantine sweep job (applies the
  retention decision).
- **hybrid-search** (important): pgvector extension + embedding column (dimension = model decision) + RRF fusion with BM25.
- graph Layer 2 (later).

## Open decision carried forward
Quarantine retention: 1 vs 2 months (needed when the sweep job is built, not before).
