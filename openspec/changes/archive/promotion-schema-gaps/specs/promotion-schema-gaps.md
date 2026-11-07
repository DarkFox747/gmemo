# Spec — promotion-schema-gaps

schema: spec-v1
change: promotion-schema-gaps
status: DRAFT
date: 2026-07-30

Testable acceptance criteria. Schema-only change; no promotion logic.

## Migration 0004
- **REQ-01** `migrations/0004_promotion_gaps.sql` follows the numbered/idempotent format of
  0002/0003, runs standalone (DATABASE_URL only, no Cognito coupling), and re-applying it is a no-op.
- **REQ-02** `staging_item` gains `promoted_at timestamptz` (nullable) and
  `promoted_memory_id uuid` (nullable) with FK → `memory(id) ON DELETE SET NULL`, both via
  `ADD COLUMN IF NOT EXISTS`.
- **REQ-03** The `staging_status` enum contains the value `partially_promoted` (added idempotently;
  not referenced within the same migration transaction).
- **REQ-04** A `quarantine` table exists as a self-contained snapshot: content columns
  (`op, type, title, summary, body, fields, content_hash, judge_reason, author_identity`),
  tenant FKs (`project_id`, `repo_id`), un-FK'd provenance breadcrumbs
  (`origin_session_id`, `origin_item_id`), `quarantined_at timestamptz NOT NULL DEFAULT now()`,
  and nullable `expires_at`. No FK to `staging_item` (so a staging sweep cannot orphan it).
- **REQ-05** `quarantine` enforces the same budget CHECKs as `staging_item`
  (title ≤ 120, summary ≤ 200, body ≤ 2000) and has an index on `project_id` (and `expires_at`
  for the future sweep). Retention period is NOT encoded in DDL.

## Idempotency support
- **REQ-06** The `promoted_at`/`promoted_memory_id` columns support per-item idempotent promotion:
  an item with `promoted_at IS NOT NULL` is considered already applied. (No logic here — the columns
  and their nullability must make the pipeline's `UPDATE ... WHERE id=$ AND promoted_at IS NULL`
  first-writer-wins pattern expressible.)

## Types / repository
- **REQ-07** `StagingItemRow` (and the `LIST_STAGING_ITEMS_SQL` projection) is extended to carry the
  new nullable columns so the type stays a faithful projection; no new queries are introduced beyond
  the SELECT column additions.
- **REQ-08** No existing 0001–0003 behavior changes; the write-path tools, RBAC, audit, and recall
  staging-mix are untouched.

## Tests
- **REQ-09** A DB-gated integration test (skipped without `DATABASE_URL`, mirroring
  `staging.migrate.integration.test.ts`) asserts: the two new `staging_item` columns + FK, the enum
  value `partially_promoted`, the `quarantine` table with its columns/CHECKs/indexes/FKs, that a
  quarantine snapshot survives deletion of its origin `staging_item` row (no orphan/cascade), and
  that re-applying 0004 is a no-op.
- **REQ-10** `pnpm build && pnpm test -- --run && pnpm lint` all pass; the existing 285 tests stay green.

## Out of scope (must NOT appear)
- **REQ-11** No `POST /promote`, no GitHub Action, no judge/sanitize/sweep logic, no new MCP tool.
- **REQ-12** No pgvector extension or embedding column (deferred to `hybrid-search`).
