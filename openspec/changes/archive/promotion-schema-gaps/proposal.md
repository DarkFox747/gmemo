# Proposal — promotion-schema-gaps

schema: proposal-v1
change: promotion-schema-gaps
status: PROPOSED
date: 2026-07-30

## Problem

The write-path slice ships `staging_item` rows, but the schema cannot yet support an
**idempotent promotion** to `memory`, nor a **quarantine** for judge-rejected items, nor a
**partially-promoted** session state. Building the promotion pipeline against a `staging_item`
table that lacks these columns would force a second migration on a table that by then holds
real staged rows. Closing the gaps first (schema-only, no behavior) keeps the pipeline change
purely about logic.

## Chosen approach

Add a single schema-only migration `0004_promotion_gaps.sql` that closes the three known gaps,
plus the minimal type/repository additions so the codebase compiles and the new columns are
representable. No new tools, no promotion logic, no external deps — that all lands in the next
change (`promotion-pipeline`).

## Scope

### IN scope
- **Migration 0004** (idempotent, numbered format like 0001–0003):
  1. `staging_item.promoted_at timestamptz` + `staging_item.promoted_memory_id uuid REFERENCES memory(id)`
     — per-item idempotency: a promoted item carries the resulting memory id + timestamp, so a
     re-run of promotion skips already-applied items.
  2. `staging_status` enum gains `partially_promoted` (a session where some items promoted and
     others went to quarantine / human queue).
  3. New `quarantine` table: rejected staged items land here with the judge reason, a
     `quarantined_at`, and a nullable `expires_at`. Retention (1 vs 2 months) is an OPERATIONAL
     policy applied later by a sweep job — NOT baked into the DDL.
- **Type/repository touch-ups** (minimal, additive): extend `StagingItemRow` (and any mapper) to
  carry the new nullable columns so reads/inserts still compile; no new queries beyond what the
  existing repository needs to stay type-correct.
- Migration integration test asserting the new columns/enum value/table + FKs + constraints exist.

### OUT of scope (deliberate)
- Any promotion LOGIC (`POST /promote`, GitHub Action, sanitize, Bedrock judge, apply, sweep job)
  → `promotion-pipeline` change.
- **pgvector / embedding column** → `hybrid-search` change. The embedding dimension depends on the
  chosen embedding model (a hybrid-search decision); fixing it now would be premature.
- Quarantine sweep/retention job and its configurable period.
- Web UI human-review queue.

## Constraints
- pnpm-ONLY; **no new runtime deps**. Numbered migration must run standalone (DATABASE_URL only),
  be idempotent (`ADD COLUMN IF NOT EXISTS`, guarded enum `ALTER TYPE ... ADD VALUE IF NOT EXISTS`,
  `CREATE TABLE IF NOT EXISTS`), and not couple to Cognito config.
- Additive only: no change to existing 0001–0003 behavior; existing 285 tests stay green.
- Secure-by-default: quarantine rows are tenant-attributable (project_id) and parameterized; no
  new enumeration surface.
- YAGNI: only the columns/table the promotion pipeline will actually write. No speculative fields.

## Affected Areas
| Area | Change |
|------|--------|
| `migrations/0004_promotion_gaps.sql` | promoted_at/promoted_memory_id, partially_promoted enum value, quarantine table |
| `src/db/stagingRepository.ts` (types) | extend StagingItemRow with the new nullable columns |
| `tests/db/*.integration.test.ts` | DB-gated assertions for the new schema objects |

(≤ 3 areas — but schema is hard to reverse once populated, so a design pass is still warranted.)

## Open questions (for architect)
1. `quarantine` as a **separate table** vs a `quarantined` value on `judge_state` + keeping the row
   in `staging_item`. Proposal leans separate table (clean separation; staging_item stays the
   pre-promotion buffer; quarantine is a terminal sink with its own retention).
2. Exact `quarantine` columns: does it copy the item content (self-contained audit) or FK back to
   `staging_item` (which may be swept)? Lean: self-contained snapshot (content_hash, type, title,
   summary, body, fields, judge_reason, project_id, repo_id, quarantined_at, expires_at) so
   retention sweeps of staging don't orphan it.
3. `promoted_memory_id` FK on-delete behavior (SET NULL vs RESTRICT).
4. Confirm pgvector groundwork is correctly deferred (dimension decision belongs to hybrid-search).

## Rejected alternatives
- **Fold the gaps into the promotion-pipeline change** — rejected per the user's sequencing and to
  avoid migrating a `staging_item` table that by then holds real rows.
- **Bake retention (1/2 mo) into the DDL** — rejected: retention is operational policy, not a schema
  invariant; a sweep job with a config value is the right layer.
