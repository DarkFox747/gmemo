-- =====================================================================
-- LPMS Cloud — Esquema de datos v2 (PostgreSQL 16)
-- Cambios sobre v1:
--   + memoria estructurada: summary, fields (jsonb) y campos por tipo.
--   + trazabilidad de origen: origin_branch (nombre literal de la rama), origin_pr.
--   + límites de tamaño en la escritura (title/summary/body) para que recall
--     nunca devuelva un registro cortado a la mitad.
--   + summary/fields propagados a memory_revision y staging_item.
-- Alcance: Layer 1 (memoria) + tenancy + staging + auditoria.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
-- CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: fase de busqueda hibrida completa

-- ------------------------------------------------------------------
-- ENUMS
-- ------------------------------------------------------------------
CREATE TYPE memory_type   AS ENUM ('decision','constraint','gotcha','pattern','integration_note','domain_rule','outcome');
CREATE TYPE memory_status AS ENUM ('active','superseded','deprecated');
CREATE TYPE provenance    AS ENUM ('pr_reviewed','manual_ui');
CREATE TYPE relation_type AS ENUM ('supersedes','conflicts_with','duplicate');
CREATE TYPE relation_src  AS ENUM ('judge','human');

CREATE TYPE staging_status AS ENUM ('open','validating','promoted','rejected','abandoned');
CREATE TYPE staging_op     AS ENUM ('add','amend','supersede','deprecate');
CREATE TYPE judge_state    AS ENUM ('pending','accepted','uncertain','rejected');

CREATE TYPE global_role  AS ENUM ('platform_owner','platform_admin');
CREATE TYPE project_role AS ENUM ('project_admin','contributor','viewer','service_agent');

CREATE TYPE actor_kind AS ENUM ('user','agent','ci','system');
CREATE TYPE access_action AS ENUM ('read','stage','promote','update','delete','admin');

-- ==================================================================
-- TENANCY
-- ==================================================================
CREATE TABLE app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idp_subject  text NOT NULL UNIQUE,
    email        text NOT NULL UNIQUE,
    display_name text,
    global_role  global_role,
    created_at   timestamptz NOT NULL DEFAULT now(),
    disabled_at  timestamptz
);

CREATE TABLE project (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE,
    name        text NOT NULL,
    created_by  uuid REFERENCES app_user(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

CREATE TABLE repo (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    remote_url       text NOT NULL UNIQUE,        -- clave natural para resolver el tenant
    provider         text,
    slug             text,                         -- owner/repo (matchea el claim OIDC de CI)
    default_branch   text NOT NULL DEFAULT 'main',
    last_indexed_sha text,
    last_graph_build_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_repo_project ON repo(project_id);

CREATE TABLE project_membership (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role       project_role NOT NULL,
    granted_by uuid REFERENCES app_user(id),
    granted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);
CREATE INDEX ix_membership_user ON project_membership(user_id);

CREATE TABLE machine_credential (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    principal_name text NOT NULL,
    token_hash     text NOT NULL,                 -- solo el hash; el secreto nunca en claro
    role           project_role NOT NULL DEFAULT 'service_agent',
    created_by     uuid REFERENCES app_user(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz
);
CREATE INDEX ix_machinecred_project ON machine_credential(project_id);

-- ==================================================================
-- MEMORIA AUTORITATIVA (MAIN) — estructurada y versionada
-- ==================================================================
CREATE TABLE memory (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id       uuid REFERENCES repo(id) ON DELETE SET NULL,
    type          memory_type NOT NULL,
    -- contenido estructurado ---------------------------------------
    title         text NOT NULL,                  -- <= 120 car.
    summary       text NOT NULL,                  -- una linea, el "que"; <= 200 car.
    body          text NOT NULL,                  -- desarrollo/rationale (markdown); <= 2000 car.
    fields        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- campos por tipo (alternatives, rule, root_cause, ...)
    -- busqueda -----------------------------------------------------
    content_tsv   tsvector GENERATED ALWAYS AS
                    (setweight(to_tsvector('simple', coalesce(title,'')),'A') ||
                     setweight(to_tsvector('simple', coalesce(summary,'')),'B') ||
                     setweight(to_tsvector('simple', coalesce(body,'')),'C')) STORED,
    -- gobernanza ---------------------------------------------------
    status        memory_status NOT NULL DEFAULT 'active',
    provenance    provenance NOT NULL,
    author_identity text NOT NULL,
    content_hash  text NOT NULL,
    current_revision int NOT NULL DEFAULT 1,
    -- trazabilidad de origen --------------------------------------
    origin_branch text,                            -- nombre literal de la rama de origen
    origin_pr     int,                             -- numero de PR que la promovio
    -- tiempos ------------------------------------------------------
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    reviewed_at   timestamptz,
    ttl_days      int,
    UNIQUE (project_id, content_hash),
    CONSTRAINT ck_memory_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_memory_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_memory_body_len    CHECK (char_length(body)    <= 2000)   -- ~500 tokens; garantiza recall entero
);
CREATE INDEX ix_memory_tsv         ON memory USING gin (content_tsv);
CREATE INDEX ix_memory_fields      ON memory USING gin (fields);
CREATE INDEX ix_memory_proj_status ON memory(project_id, status);
CREATE INDEX ix_memory_proj_type   ON memory(project_id, type);
CREATE INDEX ix_memory_repo        ON memory(repo_id);

CREATE TABLE memory_revision (
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
CREATE INDEX ix_revision_memory ON memory_revision(memory_id);

CREATE TABLE memory_relation (
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
CREATE INDEX ix_relation_from ON memory_relation(from_memory);
CREATE INDEX ix_relation_to   ON memory_relation(to_memory);

-- ==================================================================
-- STAGING
-- ==================================================================
CREATE TABLE staging_session (
    id             text PRIMARY KEY,              -- ULID
    project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id        uuid NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    branch         text NOT NULL,                 -- nombre de la rama (origen)
    status         staging_status NOT NULL DEFAULT 'open',
    opened_by      text NOT NULL,
    pr_number      int,
    pr_bound_at    timestamptz,
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    promoted_at    timestamptz
);
CREATE UNIQUE INDEX ux_session_open ON staging_session(project_id, repo_id, branch)
    WHERE status = 'open';
CREATE INDEX ix_session_status ON staging_session(status);

CREATE TABLE staging_item (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      text NOT NULL REFERENCES staging_session(id) ON DELETE CASCADE,
    op              staging_op NOT NULL,
    type            memory_type NOT NULL,
    title           text,
    summary         text,
    body            text NOT NULL,
    fields          jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash    text NOT NULL,
    target_memory_id uuid REFERENCES memory(id) ON DELETE SET NULL,
    target_revision int,
    judge_state     judge_state NOT NULL DEFAULT 'pending',
    judge_reason    text,
    sanitize_flags  jsonb NOT NULL DEFAULT '{}'::jsonb,
    author_identity text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ( (op = 'add' AND target_memory_id IS NULL)
         OR (op <> 'add' AND target_memory_id IS NOT NULL) ),
    CONSTRAINT ck_item_body_len CHECK (char_length(body) <= 2000),
    -- idempotencia: un mismo contenido no se stagea dos veces en la misma sesion
    UNIQUE (session_id, content_hash)
);
CREATE INDEX ix_item_session ON staging_item(session_id);
CREATE INDEX ix_item_judge   ON staging_item(judge_state);

-- ==================================================================
-- AUDITORIA
-- ==================================================================
CREATE TABLE access_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            timestamptz NOT NULL DEFAULT now(),
    actor_identity text NOT NULL,
    actor_kind    actor_kind NOT NULL,
    action        access_action NOT NULL,
    project_id    uuid REFERENCES project(id) ON DELETE SET NULL,
    memory_id     uuid,
    session_id    text,
    query_hash    text,                            -- hash de la query en lecturas (auditoria de recall)
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_audit_ts      ON access_log(ts);
CREATE INDEX ix_audit_project ON access_log(project_id, ts);
CREATE INDEX ix_audit_actor   ON access_log(actor_identity, ts);
