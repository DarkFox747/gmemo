# Design: promotion-schema-gaps

schema: design-v1
change: promotion-schema-gaps
status: DESIGNED
date: 2026-07-30

## Technical Approach

This is a **schema-only** change. It closes the three known promotion gaps in the
data model so the follow-on `promotion-pipeline` change is pure logic (no migration
against a `staging_item` table that by then holds real rows).

The whole change is one new numbered migration, `migrations/0004_promotion_gaps.sql`,
written in the exact idempotent, standalone style of `0002_memory.sql` and
`0003_staging.sql`:

- guarded `CREATE EXTENSION`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  `ALTER TYPE … ADD VALUE IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`;
- runs standalone via `pnpm migrate` (DATABASE_URL only — the migrator does **not**
  call `loadConfig()` and needs no `COGNITO_*` vars, confirmed in `src/db/migrate.ts`);
- additive only — no change to 0001–0003 behavior, existing test suite stays green.

Plus a minimal, faithful additive touch-up to `StagingItemRow` and the `listStagingItems`
projection so the two new nullable columns are representable. No promotion logic, no new
tools, no new runtime deps. pgvector is deferred (see Decision 6).

This maps directly to the proposal's "Chosen approach": one migration + minimal type
touch-ups, everything else pushed to `promotion-pipeline` / `hybrid-search`.

## Architecture Decisions

### Decision 1: Quarantine is a separate table, not a terminal `staging_item` state

**Choice**: A new standalone `quarantine` table. `staging_item` stays the pre-promotion
buffer only; it does **not** gain a `quarantined` value.

**Alternatives considered**: Add `quarantined` to the `staging_status`/`judge_state`
enum and keep the rejected row living in `staging_item`.

**Rationale**: `staging_item` is swept by the 7-day sliding session TTL (`0003`,
`ON DELETE CASCADE` from `staging_session`). Quarantine is a **terminal audit sink** with
its own, longer retention (1–2 months, operational — Decision 2/6). Keeping rejects in
`staging_item` would either (a) leak them into the tenant's live staging buffer and the
`recall` staging-mix, or (b) require exempting them from the TTL sweep — coupling two
lifecycles that should be independent. A separate table gives clean separation and its own
retention clock, exactly as `docs/04` §Cuarentena specifies ("Tabla propia `quarantine`").
`judge_state` already carries `rejected`; that value marks *why the item left staging*, and
the row's durable record lives in `quarantine`.

### Decision 2: Quarantine rows are a self-contained content snapshot (no live FK to staging)

**Choice**: `quarantine` copies the item's content and provenance as a snapshot:
`content_hash, op, type, title, summary, body, fields, judge_reason, author_identity,
project_id, repo_id, origin_session_id, origin_item_id, quarantined_at, expires_at`.
`origin_session_id` (ULID `text`) and `origin_item_id` (`uuid`) are **plain snapshot
columns with no foreign key** back to staging; `project_id`/`repo_id` **do** carry FKs to
the durable tenancy tables (`project`, `repo`).

**Alternatives considered**: A thin `quarantine(staging_item_id FK, judge_reason, …)` row
that joins back to `staging_item` for content.

**Rationale**: A FK to `staging_item` would be orphaned (or block the sweep) the moment the
7-day TTL deletes the session — precisely the lifecycle we separated in Decision 1. A
self-contained snapshot survives the staging sweep, which is the whole point of a terminal
audit sink; the Web UI restore flow ("restaurar = escritura `manual_ui` por el mismo core")
re-enters through the normal pipeline and re-derives any target from a fresh handle, so the
snapshot needs no live staging linkage. `project_id`/`repo_id` keep the row
**tenant-attributable** (secure-by-default; Project Admin + author can list/restore) while
still cascading correctly on tenant teardown. `origin_session_id`/`origin_item_id` are kept
as **traceability breadcrumbs only** (debugging / correlation), deliberately un-FK'd.

Deliberately **omitted** (YAGNI): `target_memory_id` / `target_revision`. Restore
re-proposes through the pipeline where the human selects a current handle, so a stale target
pointer has no consumer in this or the next change. Secret redaction ("Secretos nunca en
cuarentena en crudo → versión redactada") is **pipeline responsibility** performed before
insert — it is not a DDL concern; the columns just store `text`.

### Decision 3: `promoted_memory_id` FK is `ON DELETE SET NULL`

**Choice**: `staging_item.promoted_memory_id uuid REFERENCES memory(id) ON DELETE SET NULL`.

**Alternatives considered**: `RESTRICT` / `NO ACTION` (block deleting a memory while any
staging_item points at it).

**Rationale**: Idempotency does **not** depend on `promoted_memory_id` — it depends on
`promoted_at IS NOT NULL` (Decision 5). `promoted_memory_id` is an **audit/trace link** to
the produced memory. `RESTRICT`/`NO ACTION` would let a historical, possibly-swept
staging_item block a legitimate memory or project teardown — an undesirable referential
coupling. `SET NULL` means: if the produced memory is later deleted, the item stays
correctly marked "already promoted" (via `promoted_at`) and simply loses a pointer to a
memory that no longer exists — which is the accurate state. This is also **consistent with
the existing** `staging_item.target_memory_id … ON DELETE SET NULL` in `0003`.

### Decision 4: Enum grows via `ALTER TYPE … ADD VALUE IF NOT EXISTS`; safe inside the migrator's transaction on PG16

**Choice**:
`ALTER TYPE staging_status ADD VALUE IF NOT EXISTS 'partially_promoted';`

**The caveat, and why it does not bite here**: `src/db/migrate.ts` wraps **each** migration
file in a single explicit `BEGIN … COMMIT`. Historically (PG < 12) `ALTER TYPE … ADD VALUE`
could not run inside a transaction block at all. The target store is **RDS PostgreSQL 16**
(project-map `memory-layer1.store`), where `ADD VALUE` **is** permitted inside a transaction
block, with one restriction: the newly added value may not be *used* (referenced in
DML/DDL) in the same transaction. Migration 0004 only **adds** the value — it never inserts
or compares `'partially_promoted'` — so the restriction is not triggered and the statement
commits cleanly inside the migrator's existing transaction. No change to the migrator is
required. `IF NOT EXISTS` (PG10+) keeps it idempotent for standalone re-apply and for the
test's teardown/re-apply cycle.

### Decision 5: Per-item idempotency semantics enabled by `promoted_at` + `promoted_memory_id`

**Choice**: `staging_item` gains `promoted_at timestamptz` (nullable) and
`promoted_memory_id uuid` (nullable). An unpromoted item has both `NULL`.

**How the (deferred) pipeline will use them** — this change only guarantees the columns
exist and are nullable so the logic is *possible*:

- `promote(session)` iterates the session's items. It **skips any item where
  `promoted_at IS NOT NULL`** (already applied) — so a re-run (retry, redelivered webhook,
  crash-resume) never re-applies.
- After applying an item's `op` against `memory`, the pipeline marks it in the **same
  transaction** as the apply:
  `UPDATE staging_item SET promoted_at = now(), promoted_memory_id = $mem
   WHERE id = $item AND promoted_at IS NULL;`
  The `AND promoted_at IS NULL` guard makes the marking itself idempotent under concurrent
  runs — only the first writer wins (`rowCount = 1`); a loser sees `rowCount = 0` and
  yields.
- Idempotency is **per item, not per session** (`docs/04`: "Idempotencia por item"), so a
  run that partially failed resumes exactly where it stopped. The session-level
  `partially_promoted` status (Decision 4) records "some items applied, others went to
  quarantine / human queue" — it is a *reporting* state, orthogonal to the per-item guard.

The columns are `NULL`-defaulted and additive; the write path (which only creates
never-yet-promoted items) is unaffected.

### Decision 6: pgvector / embedding column is deferred to `hybrid-search`

**Choice**: No `vector` column and no `pgvector` extension in this change.

**Rationale**: The embedding column's dimension is fixed by the chosen embedding model,
which is a `hybrid-search` decision (project-map `deferred`, `open_decisions.deferred`).
Committing a dimension now would be premature and hard to reverse once populated. One line,
per the proposal's OUT-of-scope.

## Data Flow

This change adds **structure only**; the arrows below show what the *deferred* pipeline will
do with the new schema, to make the column intent concrete.

    remember() ──► staging_item (buffer, 7d TTL)
                        │
                        │  promotion-pipeline (DEFERRED — not this change)
                        ▼
                 per item: judge verdict
                   ├─ accepted  ──► apply op ──► memory ──┐
                   │                                      │ UPDATE staging_item SET
                   │                                      │  promoted_at, promoted_memory_id
                   │                                      ▼  (WHERE promoted_at IS NULL)
                   │                                 idempotent re-run skips this item
                   ├─ rejected  ──► INSERT snapshot ─► quarantine (own retention clock)
                   └─ uncertain ──► human queue (Web UI)

                 session status ──► partially_promoted (some applied, some not)

## migrations/0004_promotion_gaps.sql (exact DDL)

```sql
-- Migration 0004: promotion schema gaps (schema-only; no promotion logic).
-- Closes the three known gaps so promotion-pipeline is pure logic:
--   1. staging_item.promoted_at + promoted_memory_id  — per-item idempotency.
--   2. staging_status += 'partially_promoted'         — mixed-outcome session.
--   3. quarantine table                               — judge-rejected sink.
-- Faithful to docs/04-escritura-staging-promocion.md (§Pipeline, §Cuarentena)
-- and docs/artefactos/lpms_schema_v2.sql conventions (UUID pgcrypto, budget CHECKs).
-- pgvector is intentionally NOT added here — dimension is a hybrid-search decision.
-- Idempotent: safe to apply more than once (guards on all DDL). Standalone: needs
-- only DATABASE_URL. ADD VALUE runs inside the migrator's txn safely on PG16 because
-- the new value is not USED within this migration (see design Decision 4).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- GAP 1 — per-item idempotency columns on staging_item
-- Both nullable; an unpromoted item carries NULL/NULL. FK SET NULL so a
-- deleted memory never blocks teardown and never breaks the promoted_at
-- "already applied" marker (design Decision 3 / Decision 5).
-- ------------------------------------------------------------------
ALTER TABLE staging_item
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

ALTER TABLE staging_item
  ADD COLUMN IF NOT EXISTS promoted_memory_id uuid
    REFERENCES memory(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- GAP 2 — staging_status gains 'partially_promoted'
-- IF NOT EXISTS => idempotent. Not referenced elsewhere in this file, so it
-- commits cleanly inside the migrator's per-file transaction on PG16.
-- ------------------------------------------------------------------
ALTER TYPE staging_status ADD VALUE IF NOT EXISTS 'partially_promoted';

-- ------------------------------------------------------------------
-- GAP 3 — quarantine (self-contained snapshot of judge-rejected items)
-- Snapshot survives the 7-day staging sweep (no FK to staging_item/session).
-- Tenant-attributable via project_id/repo_id FKs. Budget CHECKs mirror
-- staging_item so restored content stays within the same limits.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quarantine (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id           uuid REFERENCES repo(id) ON DELETE SET NULL,
    -- Traceability breadcrumbs to the origin staging rows — NO FK on purpose
    -- (staging is swept; snapshot must not be orphaned/blocked).
    origin_session_id text,                                   -- ULID (app-generated)
    origin_item_id    uuid,
    -- Content snapshot (same shape/budgets as staging_item).
    op                staging_op  NOT NULL,
    type              memory_type NOT NULL,
    title             text NOT NULL,
    summary           text NOT NULL,
    body              text NOT NULL,
    fields            jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash      text NOT NULL,
    -- Why it was rejected (the reason a quarantine row exists).
    judge_reason      text NOT NULL,
    author_identity   text NOT NULL,
    quarantined_at    timestamptz NOT NULL DEFAULT now(),
    -- Retention is OPERATIONAL policy set by a future sweep job, NOT a DDL
    -- constant. Nullable: NULL = no expiry set yet.
    expires_at        timestamptz,
    CONSTRAINT ck_quarantine_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_quarantine_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_quarantine_body_len    CHECK (char_length(body)    <= 2000)
);

-- Tenant-scoped listing for the Web UI review/restore queue.
CREATE INDEX IF NOT EXISTS ix_quarantine_project ON quarantine(project_id);

-- Efficient retention sweep; partial index mirrors ix_memory_ttl (0002) style.
CREATE INDEX IF NOT EXISTS ix_quarantine_expires
    ON quarantine(expires_at) WHERE expires_at IS NOT NULL;
```

Notes:
- No supporting index on `promoted_memory_id` is added: staging is low-volume and
  memory hard-deletes are rare (project teardown), so the FK's reverse scan cost is
  negligible. Add it only if the pipeline later shows a need (YAGNI).
- `staging_op` and `memory_type` enums already exist (0002/0003); no re-guard needed
  because 0004 depends on 0002/0003 having run (forward-only runner, lexical order).

## Repository / type changes (minimal, additive)

Strictly, **no type change is required to compile**: both `INSERT_STAGING_ITEM_SQL` and
`LIST_STAGING_ITEMS_SQL` use explicit column lists, so adding DB columns breaks nothing.
To keep `StagingItemRow` a faithful full projection (and avoid a second edit in
`promotion-pipeline`), make this small additive touch-up in
`src/db/stagingRepository.ts`:

1. Add two nullable fields to `StagingItemRow`:
   ```ts
   promoted_at: Date | null;
   promoted_memory_id: string | null;
   ```
2. Add the same two fields to the private `RawStagingItemRow`
   (`promoted_at: Date | null; promoted_memory_id: string | null;`).
3. Extend the `LIST_STAGING_ITEMS_SQL` SELECT list with
   `i.promoted_at, i.promoted_memory_id` and map them in `listStagingItems`.
   For open-session items these are always `NULL` (open items are never promoted),
   so behavior is unchanged.

**No new query and no new repository method** in this change. The `insertStagingItem`
path is untouched (new columns default to `NULL`). All quarantine reads/writes and the
promotion `UPDATE` belong to `promotion-pipeline`.

Existing tests are unaffected: `stagingRepository.integration.test.ts` asserts individual
fields (`titles`, `id`, `deduped`, `judgeState`), never a deep-equal of the whole row, so
adding two nullable fields does not break assertions.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `migrations/0004_promotion_gaps.sql` | Create | The DDL above: `staging_item.promoted_at` + `promoted_memory_id` (FK SET NULL), `staging_status += 'partially_promoted'`, `quarantine` table + 2 indexes + 3 budget CHECKs. |
| `src/db/stagingRepository.ts` | Modify | Add two nullable fields to `StagingItemRow` and `RawStagingItemRow`; add `i.promoted_at, i.promoted_memory_id` to `LIST_STAGING_ITEMS_SQL` and map them. No new query/method. |
| `tests/db/promotionGaps.migrate.integration.test.ts` | Create | DB-gated migration integration test (skipped when `DATABASE_URL` unset), mirroring `staging.migrate.integration.test.ts` structure. See Test plan. |

## Test plan (DB-gated integration, `describe.skip` when `DATABASE_URL` unset)

New file `tests/db/promotionGaps.migrate.integration.test.ts`, same skip-guard,
seed-then-teardown pattern as `staging.migrate.integration.test.ts`:

**Setup**: `runMigrations(DATABASE_URL)` (0001 → 0004; idempotent), seed a `project`,
`repo`, one `memory` row (FK target), one `staging_session`, one `staging_item`.

**Assertions**:
1. **Columns exist** — `information_schema.columns` shows `staging_item.promoted_at`
   (`timestamptz`, nullable) and `staging_item.promoted_memory_id` (`uuid`, nullable).
2. **FK on-delete is SET NULL** — query `information_schema.referential_constraints`
   (or `pg_constraint.confdeltype = 'n'`) for the `promoted_memory_id → memory(id)` FK.
3. **Enum value present** — `SELECT enum_range(NULL::staging_status)` (or `pg_enum` join)
   contains `'partially_promoted'`.
4. **`quarantine` table exists** — `to_regclass('quarantine')` is non-null.
5. **Quarantine FKs** — `project_id → project(id)` (CASCADE) and `repo_id → repo(id)`
   (SET NULL) present in `pg_constraint`.
6. **Quarantine indexes** — `ix_quarantine_project` exists; `ix_quarantine_expires` exists
   and is partial (its `indexdef` contains `WHERE`).
7. **Quarantine budget CHECKs reject** — inserts with title > 120 / summary > 200 /
   body > 2000 fail with code `23514`; a valid snapshot insert succeeds.
8. **Quarantine survives staging sweep** — insert a quarantine snapshot, then delete its
   `origin_session_id`'s `staging_session` (CASCADE removes the staging_item); assert the
   quarantine row is still present (no FK, not orphaned).
9. **`partially_promoted` is usable** — after migration, an
   `UPDATE staging_session SET status = 'partially_promoted'` succeeds (proves the value
   committed and is referenceable in a *later* transaction — the PG16 caveat boundary).
10. **Idempotent re-apply is a no-op** — run the raw `0004` SQL a second time directly
    (outside the ledger) and assert it does not throw (all guards hold:
    `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, `CREATE TABLE/INDEX IF NOT EXISTS`).
11. **Ledger records `0004_promotion_gaps`**.

**Teardown**: `DROP TABLE IF EXISTS quarantine CASCADE`; delete the `0004_promotion_gaps`
ledger row; delete the seeded `project` (cascades to repo/memory/staging). Note: the added
`staging_status` value and the two `staging_item` columns are left in place (enum values
cannot be dropped; the columns are additive) — this is consistent with the forward-only
runner and does not affect other suites.

Full-suite gate unchanged: `pnpm build && pnpm test -- --run && pnpm lint`; the existing
suite stays green (additive-only change).

## Explicitly deferred

- **All promotion logic** → `promotion-pipeline`: `POST /promote`, GitHub Action (OIDC),
  sanitize, Bedrock 3-state judge, the idempotent apply + the `promoted_at`/
  `promoted_memory_id` `UPDATE`, writing `quarantine` rows, setting `partially_promoted`,
  the retention **sweep job** and its configurable 1–2 month period, and the Web UI
  human-review/restore queue.
- **pgvector / embedding column** → `hybrid-search` (dimension depends on the embedding
  model — Decision 6).
- **Secret redaction of quarantined content** is pipeline behavior (sanitize before insert),
  not a DDL concern in this change.
