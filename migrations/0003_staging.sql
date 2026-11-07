-- Migration 0003: staging session + item tables.
-- Faithful subset of docs/artefactos/lpms_schema_v2.sql — the three staging enums
-- and the two staging tables (staging_session, staging_item) with partial unique
-- index, budget CHECKs, and op↔target CHECK.
-- staging_op already exists from 0002 (memory_revision.op); re-guarded here so
-- this file is self-contained and safe to apply standalone (no 0002 order dep).
-- Idempotent: safe to apply more than once (guards on all DDL).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- ENUMS (idempotent: exception-swallowed if type already exists)
-- ------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE staging_status AS ENUM
    ('open','validating','promoted','rejected','abandoned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE judge_state AS ENUM
    ('pending','accepted','uncertain','rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Re-guarded from 0002 — staging_op is also used by memory_revision.
DO $$ BEGIN
  CREATE TYPE staging_op AS ENUM
    ('add','amend','supersede','deprecate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------------
-- STAGING SESSION
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging_session (
    id               text PRIMARY KEY,                         -- ULID (app-generated)
    project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id          uuid NOT NULL REFERENCES repo(id)   ON DELETE CASCADE,
    branch           text NOT NULL,
    status           staging_status NOT NULL DEFAULT 'open',
    opened_by        text NOT NULL,
    pr_number        int,                                      -- unused this slice
    pr_bound_at      timestamptz,                              -- unused this slice
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz,                              -- now()+7d sliding TTL
    created_at       timestamptz NOT NULL DEFAULT now(),
    promoted_at      timestamptz                               -- v2 column; unused
);

-- One open session per (project, repo, branch) — partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_open
    ON staging_session(project_id, repo_id, branch) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS ix_session_status ON staging_session(status);

-- ------------------------------------------------------------------
-- STAGING ITEM
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staging_item (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       text NOT NULL REFERENCES staging_session(id) ON DELETE CASCADE,
    op               staging_op NOT NULL,
    type             memory_type NOT NULL,
    title            text NOT NULL,                            -- Decision 1
    summary          text NOT NULL,                            -- Decision 1
    body             text NOT NULL,
    fields           jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash     text NOT NULL,
    target_memory_id uuid REFERENCES memory(id) ON DELETE SET NULL,
    target_revision  int,
    judge_state      judge_state NOT NULL DEFAULT 'pending',
    judge_reason     text,
    sanitize_flags   jsonb NOT NULL DEFAULT '{}'::jsonb,
    author_identity  text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_item_optarget CHECK (
        (op =  'add' AND target_memory_id IS NULL)
     OR (op <> 'add' AND target_memory_id IS NOT NULL) ),
    CONSTRAINT ck_item_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_item_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_item_body_len    CHECK (char_length(body)    <= 2000),
    UNIQUE (session_id, content_hash)
);

CREATE INDEX IF NOT EXISTS ix_item_session ON staging_item(session_id);
CREATE INDEX IF NOT EXISTS ix_item_judge   ON staging_item(judge_state);
