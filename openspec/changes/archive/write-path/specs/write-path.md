# Spec — write-path (write-to-staging slice)

schema: spec-v1
change: write-path
status: DRAFT
date: 2026-07-30

Requirements are testable acceptance criteria. IDs are stable; tasks reference them.

## Staging schema (migration 0003)

- **REQ-01** A numbered migration `0003_staging.sql` creates `staging_session` and
  `staging_item` per schema v2, in the same format as `0001`/`0002` (applied by the existing
  numbered migrator; no seed coupling).
- **REQ-02** `staging_session` has a ULID text PK and a **partial unique index** guaranteeing at
  most one row with `status='open'` per `(project_id, repo_id, branch)`.
- **REQ-03** `staging_item.title` and `staging_item.summary` are enforced NOT NULL (the facade
  contract requires them), and budget CHECKs hold: `length(title) ≤ 120`, `length(summary) ≤ 200`,
  `length(body) ≤ 2000`.
- **REQ-04** A CHECK enforces op↔target symmetry: `op='add'` ⇒ `target_memory_id IS NULL`;
  `op IN ('amend','supersede','deprecate')` ⇒ `target_memory_id IS NOT NULL`.
- **REQ-05** `UNIQUE(session_id, content_hash)` exists so re-staging identical content is a no-op.
- **REQ-06** All migration objects are tenant-agnostic DDL only (no data), reversible-safe, and
  do not require Cognito config to run (mirrors the 0001/0002 decoupling).

## remember tool

- **REQ-07** `remember(op, type, title, summary, body, fields?, target_handle?)` is registered on
  the MCP server and returns `{ id, state }` for the created (or deduped) staging item.
- **REQ-08** `remember` writes ONLY to a staging session — never to the `memory` table. The session
  is lazily created (or reused) for the caller's `(project, repo, branch)`; the agent never passes IDs.
- **REQ-09** `op='add'` MUST omit `target_handle`; `op IN ('amend','supersede','deprecate')` MUST
  provide a valid `target_handle`. Violations return `INVALID_REFERENCE` (no resource enumeration).
- **REQ-10** A provided `target_handle` is decoded via the existing handle codec; a malformed handle
  returns `INVALID_REFERENCE`; a stale handle (revision moved) is accepted but the item is flagged
  `uncertain` per the staging lifecycle.
- **REQ-11** Content budgets are validated (title ≤ 120, summary ≤ 200, body ≤ 2000) before persist.
- **REQ-12** `type` is one of the 7 memory types; `fields` is validated per the design's per-type map.
- **REQ-13** Re-staging content whose `content_hash` already exists in the open session returns the
  existing item (idempotent no-op), not an error or a duplicate row.

## list_staged / discard_staged

- **REQ-14** `list_staged()` returns the caller's own open-session staged items only (never another
  session/tenant), with per-item id, op, type, title, and state.
- **REQ-15** `discard_staged(item_id)` removes an item from the caller's own open session only.
  Discarding an item that is absent or belongs to another session returns `INVALID_REFERENCE`
  (no cross-session/tenant enumeration).

## recall staging-mix

- **REQ-16** `recall` merges the caller's active-session staged items into results, tagged
  `source:"staged"` (main results remain `source:"main"`), per the design's ordering rule.
- **REQ-17** Staged items are visible only to the caller's own tenant+session; another project's
  or session's staged items never appear.

## RBAC + audit (secure-by-default)

- **REQ-18** The `ToolName` union is widened to include `remember`, `list_staged`, `discard_staged`,
  AND the authorizer enforces `contributor`/`service_agent` for those tools — landed together so
  there is never a build in which a Viewer passes a write gate.
- **REQ-19** A Viewer (read-only member) calling any write tool receives `PERMISSION_DENIED` with no
  tenant/resource detail.
- **REQ-20** Every successful write (`remember`, `discard_staged`) records an `access_log` row via
  `AuditLogger.recordWrite` with `action='stage'`, actor identity, and no raw content (hash only).

## Security

- **REQ-21** A synchronous inline secret-scan runs BEFORE persisting any staging item; on a positive
  match OR a scan error the write is refused (fail-closed) and no plaintext is persisted.
- **REQ-22** No new runtime dependency is added; the secret-scan is inline. pnpm-lock unchanged except
  as regenerated out-of-band by a human if ever needed (not required for this change).
- **REQ-23** All SQL is parameterized and tenant-scoped (`project_id = $N`); no string concatenation.

## Tests

- **REQ-24** Registration test asserts the 3 write tools appear via SDK `InMemoryTransport + Client`.
- **REQ-25** Handler tests (direct call with an in-memory staging fake) cover: add happy path, dedup
  no-op, op↔target validation, stale-handle→uncertain, budget violation, secret-scan fail-closed,
  Viewer→PERMISSION_DENIED, and list/discard own-session-only.
- **REQ-26** DB integration tests (skipped unless `DATABASE_URL` set) assert the partial unique index,
  op↔target CHECK, and content_hash dedup behavior against real Postgres.
- **REQ-27** `pnpm build && pnpm test -- --run && pnpm lint` all pass.
