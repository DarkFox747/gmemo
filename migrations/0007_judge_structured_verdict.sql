-- Migration 0007: structured judge verdict + review-queue state (C1).
-- Additive only. Idempotent: every statement is guarded. sanitize_flags and
-- judge_reason already exist on staging_item (0003) and are reused, not re-added.

DO $$ BEGIN
  CREATE TYPE review_decision AS ENUM ('approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Judge outcome (criterion/confidence; justification reuses judge_reason).
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS judge_criterion  text;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS judge_confidence real;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS mandatory_review boolean NOT NULL DEFAULT false;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS related_memory_id uuid
  REFERENCES memory(id) ON DELETE SET NULL;

-- Human review (written by C2; created now so the queue state is complete).
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS reviewed_by uuid
  REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS review_decision review_decision;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS review_reason   text;
ALTER TABLE staging_item ADD COLUMN IF NOT EXISTS reviewed_at     timestamptz;

ALTER TABLE memory ADD COLUMN IF NOT EXISTS approved_by uuid
  REFERENCES app_user(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ck_item_judge_confidence'
                   AND conrelid = 'staging_item'::regclass) THEN
    ALTER TABLE staging_item ADD CONSTRAINT ck_item_judge_confidence
      CHECK (judge_confidence IS NULL OR (judge_confidence >= 0 AND judge_confidence <= 1));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ck_item_judge_criterion'
                   AND conrelid = 'staging_item'::regclass) THEN
    ALTER TABLE staging_item ADD CONSTRAINT ck_item_judge_criterion
      CHECK (judge_criterion IS NULL OR judge_criterion IN
        ('specificity','duplication','contradiction','grounding',
         'confidence','security_second_layer','stale_target'));
  END IF;
END $$;
