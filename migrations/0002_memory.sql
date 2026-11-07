-- Migration 0002: memory READ core (memory + memory_revision + memory_relation).
-- Faithful subset of docs/artefactos/lpms_schema_v2.sql — the enums used by the
-- three read tables and the tables/indexes themselves. Staging tables are NOT
-- created (change B is read-only; see design D1).
-- ONLY deviation from schema v2: content_tsv uses the 'english' dictionary
-- instead of 'simple' (design D2) — decided before any data is written.
-- Idempotent: safe to apply more than once (guards on all DDL).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- ENUMS (idempotent: exception-swallowed if type already exists)
-- ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM
    ('decision','constraint','gotcha','pattern','integration_note','domain_rule','outcome');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE memory_status AS ENUM ('active','superseded','deprecated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE provenance AS ENUM ('pr_reviewed','manual_ui');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- memory_revision.op is typed staging_op; the enum is required here even though
-- the staging tables are deferred (design D1).
DO $$ BEGIN
  CREATE TYPE staging_op AS ENUM ('add','amend','supersede','deprecate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE relation_type AS ENUM ('supersedes','conflicts_with','duplicate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE relation_src AS ENUM ('judge','human');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------------
-- MEMORY (authoritative, structured, versioned)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id       uuid REFERENCES repo(id) ON DELETE SET NULL,
    type          memory_type NOT NULL,
    title         text NOT NULL,                 -- <= 120 chars (CHECK below)
    summary       text NOT NULL,                 -- <= 200 chars
    body          text NOT NULL,                 -- <= 2000 chars (markdown)
    fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- D2: 'english' dictionary (schema v2 used 'simple') — weights A/B/C.
    content_tsv   tsvector GENERATED ALWAYS AS
                    (setweight(to_tsvector('english', coalesce(title,'')),'A') ||
                     setweight(to_tsvector('english', coalesce(summary,'')),'B') ||
                     setweight(to_tsvector('english', coalesce(body,'')),'C')) STORED,
    status        memory_status NOT NULL DEFAULT 'active',
    provenance    provenance NOT NULL,
    author_identity text NOT NULL,
    content_hash  text NOT NULL,
    current_revision int NOT NULL DEFAULT 1,
    origin_branch text,
    origin_pr     int,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    reviewed_at   timestamptz,
    ttl_days      int,
    UNIQUE (project_id, content_hash),
    CONSTRAINT ck_memory_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_memory_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_memory_body_len    CHECK (char_length(body)    <= 2000)
);

-- Schema v2 indexes (faithful)
CREATE INDEX IF NOT EXISTS ix_memory_tsv         ON memory USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS ix_memory_fields      ON memory USING gin (fields);
CREATE INDEX IF NOT EXISTS ix_memory_proj_status ON memory(project_id, status);
CREATE INDEX IF NOT EXISTS ix_memory_proj_type   ON memory(project_id, type);
CREATE INDEX IF NOT EXISTS ix_memory_repo        ON memory(repo_id);
-- D8 additions
CREATE INDEX IF NOT EXISTS ix_memory_proj_status_type ON memory(project_id, status, type);
CREATE INDEX IF NOT EXISTS ix_memory_ttl ON memory(project_id, ttl_days) WHERE ttl_days IS NOT NULL;

-- ------------------------------------------------------------------
-- MEMORY_REVISION (immutable audit trail)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_revision (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    revision_no   int NOT NULL,
    op            staging_op NOT NULL,
    title         text NOT NULL,
    summary       text NOT NULL,
    body          text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
    type          memory_type NOT NULL,
    content_hash  text NOT NULL,
    author_identity text NOT NULL,
    promoted_from_item uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (memory_id, revision_no)
);
CREATE INDEX IF NOT EXISTS ix_revision_memory ON memory_revision(memory_id);

-- ------------------------------------------------------------------
-- MEMORY_RELATION (typed edges)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_relation (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_memory   uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    to_memory     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    relation_type relation_type NOT NULL,
    confidence    real,
    source        relation_src NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (from_memory <> to_memory),
    UNIQUE (from_memory, to_memory, relation_type)
);
CREATE INDEX IF NOT EXISTS ix_relation_from ON memory_relation(from_memory);
CREATE INDEX IF NOT EXISTS ix_relation_to   ON memory_relation(to_memory);
