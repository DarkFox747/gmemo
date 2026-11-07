-- Migration 0006: machine_credential uniqueness constraint.
-- Adds UNIQUE (project_id, principal_name) so that the runbook INSERT can use
-- an explicit ON CONFLICT target and provisioning is truly idempotent.
-- The runner wraps each file in a single BEGIN/COMMIT; CONCURRENTLY is not used.

ALTER TABLE machine_credential
  ADD CONSTRAINT machine_credential_project_id_principal_name_key
    UNIQUE (project_id, principal_name);
