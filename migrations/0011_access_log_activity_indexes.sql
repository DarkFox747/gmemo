-- Migration 0011: access_log indexes for the Actividad timeline (C12, governance-insights).
-- Additive and idempotent. Both are partial indexes matching the two keyset branches of
-- the activity query (ORDER BY id DESC LIMIT n); read rows (the bulk of the table) are excluded.

-- Project branch: state-changing events of one project, newest first.
CREATE INDEX IF NOT EXISTS ix_audit_project_activity
  ON access_log (project_id, id DESC) WHERE action <> 'read';

-- Job branch: project-less system job runs (per-project counts live in detail.detail).
CREATE INDEX IF NOT EXISTS ix_audit_job_activity
  ON access_log (id DESC)
  WHERE project_id IS NULL AND actor_kind = 'system' AND action = 'admin';
