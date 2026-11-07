-- Migration 0004: promotion schema gaps (schema-only; no promotion logic).
-- Closes the three known gaps so promotion-pipeline is pure logic:
--   1. staging_item.promoted_at + promoted_memory_id  — per-item idempotency.
--   2. staging_status += 'partially_promoted'         — mixed-outcome session.
--   3. quarantine table                               — judge-rejected sink.
-- Faithful to docs/04-escritura-staging-promocion.md (§Pipeline, §Cuarentena)
-- and docs/artefactos/gmemo_schema_v2.sql conventions (UUID pgcrypto, budget CHECKs).
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
