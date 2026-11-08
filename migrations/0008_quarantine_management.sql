-- Migration 0008: quarantine management (C3 / HU-10).
-- Additive and idempotent: every statement is guarded; the backfill only touches
-- unclassified rows. Columns stay nullable so pre-C3 code keeps inserting.
-- The classification CASE mirrors classifyQuarantine (src/quarantine/reason.ts);
-- tests run the same fixture table against both so they cannot drift.

DO $$ BEGIN
  CREATE TYPE quarantine_criterion AS ENUM ('pipeline','judge','human_review');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quarantine_reason_code AS ENUM
    ('secret_detected','embedded_instructions','duplicate_content',
     'judge_rejected','human_rejected','sanitize_failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS criterion   quarantine_criterion;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS reason_code quarantine_reason_code;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS related_memory_id uuid
  REFERENCES memory(id) ON DELETE SET NULL;
-- Needed to rebuild a non-add item on restore (ck_item_optarget).
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS target_memory_id uuid
  REFERENCES memory(id) ON DELETE SET NULL;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS target_revision int;
-- Restore label (judge measurement: restored_at IS NOT NULL = false-positive candidate).
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_by uuid
  REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_at timestamptz;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_item_id uuid;   -- no FK: staging is swept

-- Backfill classification + related/target from the origin item when it still exists.
-- Fallback when the item was swept: duplicate_content → pipeline (no criterion to read).
-- starts_with (not LIKE): '_' is a LIKE wildcard.
UPDATE quarantine q
SET criterion         = m.criterion,
    reason_code       = m.reason_code,
    related_memory_id = COALESCE(q.related_memory_id, m.related_memory_id),
    target_memory_id  = COALESCE(q.target_memory_id,  m.target_memory_id),
    target_revision   = COALESCE(q.target_revision,   m.target_revision)
FROM (
  SELECT q2.id,
    (CASE
       WHEN starts_with(q2.judge_reason, 'human_review:')                                    THEN 'human_review'
       WHEN q2.judge_reason IN ('secret_detected','embedded_instructions','sanitize_failed') THEN 'pipeline'
       WHEN q2.judge_reason = 'duplicate_content' AND si.judge_criterion = 'duplication'     THEN 'judge'
       WHEN q2.judge_reason = 'duplicate_content'                                            THEN 'pipeline'
       ELSE 'judge'                       -- security_second_layer, specificity, legacy judge_rejected, other
     END)::quarantine_criterion AS criterion,
    (CASE
       WHEN starts_with(q2.judge_reason, 'human_review:')   THEN 'human_rejected'
       WHEN q2.judge_reason = 'secret_detected'             THEN 'secret_detected'
       WHEN q2.judge_reason = 'security_second_layer'       THEN 'secret_detected'
       WHEN q2.judge_reason = 'embedded_instructions'       THEN 'embedded_instructions'
       WHEN q2.judge_reason = 'sanitize_failed'             THEN 'sanitize_failed'
       WHEN q2.judge_reason = 'duplicate_content'           THEN 'duplicate_content'
       ELSE 'judge_rejected'
     END)::quarantine_reason_code AS reason_code,
    si.related_memory_id, si.target_memory_id, si.target_revision
  FROM quarantine q2
  LEFT JOIN staging_item si ON si.id = q2.origin_item_id
  WHERE q2.criterion IS NULL
) m
WHERE q.id = m.id;

-- Retention backfill (proposal: quarantined_at + 60 days; rows older than that
-- become purgeable on the first job run — documented in DEVELOPMENT.md).
UPDATE quarantine SET expires_at = quarantined_at + interval '60 days' WHERE expires_at IS NULL;

-- List query: project-scoped, newest first, active (non-restored) rows only.
CREATE INDEX IF NOT EXISTS ix_quarantine_list
  ON quarantine (project_id, quarantined_at DESC, id DESC) WHERE restored_at IS NULL;
