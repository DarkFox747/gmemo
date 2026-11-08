-- Migration 0010: memory lifecycle columns, backfill and indexes (C4, HU-12, HU-11.4).
-- Additive and idempotent. Depends on 0009 (already committed by the runner).

ALTER TABLE memory ADD COLUMN IF NOT EXISTS revalidate_at  timestamptz;  -- NULL = never expires (outcome / non-active)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS retired_reason text;         -- set only by retire / retire-by-pr

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ck_memory_retired_reason_len'
                   AND conrelid = 'memory'::regclass) THEN
    ALTER TABLE memory ADD CONSTRAINT ck_memory_retired_reason_len
      CHECK (retired_reason IS NULL OR char_length(retired_reason) BETWEEN 3 AND 500);
  END IF;
END $$;

-- Backfill: existing active non-outcome memories get a 60-day window. The value is
-- fixed (a migration cannot read REVALIDATION_DAYS). The IS NULL guard keeps it idempotent.
UPDATE memory
SET revalidate_at = now() + interval '60 days'
WHERE status = 'active' AND type <> 'outcome' AND revalidate_at IS NULL;

-- Retire-by-PR lookup. It covers active AND pending_revalidation rows: origin_pr = $n
-- implies origin_pr IS NOT NULL, so the planner can use this partial index.
CREATE INDEX IF NOT EXISTS ix_memory_proj_origin_pr
  ON memory (project_id, origin_pr) WHERE origin_pr IS NOT NULL;

-- Revalidation sweep (status='active' AND revalidate_at < now()).
CREATE INDEX IF NOT EXISTS ix_memory_revalidate_due
  ON memory (revalidate_at) WHERE status = 'active';
