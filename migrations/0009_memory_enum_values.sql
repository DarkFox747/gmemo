-- Migration 0009: memory lifecycle enum values (C4, HU-12).
-- ONLY ADD VALUE statements. The new values are NOT used in this file: PG16 allows
-- ADD VALUE inside the runner's per-file transaction, but a value added in a
-- transaction cannot be used before that transaction commits (0004 precedent).
-- IF NOT EXISTS makes re-application a no-op.
ALTER TYPE memory_status ADD VALUE IF NOT EXISTS 'pending_revalidation';
ALTER TYPE provenance    ADD VALUE IF NOT EXISTS 'web_ui';   -- written by C5 (direct create/edit)
