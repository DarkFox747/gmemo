-- Migration 0001: auth + tenancy tables
-- Faithful subset of docs/artefactos/lpms_schema_v2.sql — the 4 enums used by
-- the auth/audit tables and the 6 tenancy/audit tables themselves.
-- This file is idempotent: safe to apply more than once (guards on all DDL).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- ENUMS (idempotent: exception-swallowed if type already exists)
-- ------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE global_role AS ENUM ('platform_owner', 'platform_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE project_role AS ENUM ('project_admin', 'contributor', 'viewer', 'service_agent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE actor_kind AS ENUM ('user', 'agent', 'ci', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE access_action AS ENUM ('read', 'stage', 'promote', 'update', 'delete', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------------
-- TENANCY
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idp_subject  text NOT NULL UNIQUE,
    email        text NOT NULL UNIQUE,
    display_name text,
    global_role  global_role,
    created_at   timestamptz NOT NULL DEFAULT now(),
    disabled_at  timestamptz
);

CREATE TABLE IF NOT EXISTS project (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_by  uuid REFERENCES app_user(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS repo (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    remote_url          text NOT NULL UNIQUE,       -- natural key for tenant resolution
    provider            text,
    slug                text,
    default_branch      text NOT NULL DEFAULT 'main',
    last_indexed_sha    text,
    last_graph_build_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_repo_project ON repo(project_id);

CREATE TABLE IF NOT EXISTS project_membership (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role       project_role NOT NULL,
    granted_by uuid REFERENCES app_user(id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_membership_user ON project_membership(user_id);

CREATE TABLE IF NOT EXISTS machine_credential (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    principal_name text NOT NULL,
    token_hash     text NOT NULL,                -- hash only; secret never stored in clear
    role           project_role NOT NULL DEFAULT 'service_agent',
    created_by     uuid REFERENCES app_user(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ix_machinecred_project ON machine_credential(project_id);

-- ------------------------------------------------------------------
-- AUDIT
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS access_log (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts             timestamptz NOT NULL DEFAULT now(),
    actor_identity text NOT NULL,
    actor_kind     actor_kind NOT NULL,
    action         access_action NOT NULL,
    project_id     uuid REFERENCES project(id) ON DELETE SET NULL,
    memory_id      uuid,
    session_id     text,
    query_hash     text,                           -- server-side hash of the read query; never raw text
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_audit_ts      ON access_log(ts);
CREATE INDEX IF NOT EXISTS ix_audit_project ON access_log(project_id, ts);
CREATE INDEX IF NOT EXISTS ix_audit_actor   ON access_log(actor_identity, ts);
