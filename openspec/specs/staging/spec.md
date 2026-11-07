# Staging Specification

## Purpose

The write-to-staging path: the `staging_session` and `staging_item` schema, the `remember`, `list_staged` and `discard_staged` tools, staging-mix in `recall`, write RBAC, audit and the inline secret scan. Promotion of staged items into `memory` is specified in `promotion`.

## Requirements

### Requirement: Staging schema (migration 0003)

`0003_staging.sql` MUST create `staging_session` and `staging_item` per schema v2 as tenant-agnostic DDL only, in the same format as 0001/0002 and without Cognito coupling. `staging_session` MUST have a ULID text PK and a partial unique index allowing at most one `status='open'` row per `(project_id, repo_id, branch)`. `staging_item.title` and `summary` MUST be NOT NULL with CHECKs `length(title) <= 120`, `length(summary) <= 200`, `length(body) <= 2000`. A CHECK MUST enforce `op='add'` implies `target_memory_id IS NULL` and `op IN ('amend','supersede','deprecate')` implies `target_memory_id IS NOT NULL`. `UNIQUE(session_id, content_hash)` MUST exist.

Source: write-path

#### Scenario: Second open session

- GIVEN an open session for a project, repo and branch
- WHEN inserting another open session for the same tuple
- THEN the partial unique index rejects it

#### Scenario: Op/target mismatch

- GIVEN a staging item with `op='amend'` and no target
- WHEN inserting it
- THEN the CHECK rejects it

### Requirement: remember tool

`remember(op, type, title, summary, body, fields?, target_handle?)` MUST be registered and return `{ id, state }` for the created or deduped item. It MUST write ONLY to a staging session (never `memory`), lazily creating or reusing the session for the caller's `(project, repo, branch)`; the agent MUST NOT pass IDs. `op='add'` MUST omit `target_handle`; other ops MUST provide a valid one, else `INVALID_REFERENCE`. A malformed handle returns `INVALID_REFERENCE`; a stale handle is accepted and the item is flagged `uncertain`. Budgets MUST be validated before persist, `type` MUST be one of the 7 memory types, and `fields` MUST be validated per type. Re-staging content whose `content_hash` already exists in the open session MUST return the existing item (idempotent no-op).

Source: write-path

#### Scenario: Add happy path

- GIVEN a contributor with a valid payload
- WHEN calling `remember` with `op='add'`
- THEN an item is staged in the open session and `{ id, state }` is returned

#### Scenario: Dedup

- GIVEN an item with the same `content_hash` in the open session
- WHEN calling `remember` again with identical content
- THEN the existing item is returned and no duplicate row is created

#### Scenario: Stale target

- GIVEN a `target_handle` whose revision has moved
- WHEN calling `remember` with `op='amend'`
- THEN the item is accepted with state `uncertain`

### Requirement: list_staged and discard_staged

`list_staged()` MUST return only the caller's own open-session items with id, op, type, title and state. `discard_staged(item_id)` MUST remove an item from the caller's own open session only; an absent item or one in another session MUST return `INVALID_REFERENCE`.

Source: write-path

#### Scenario: Cross-session discard

- GIVEN an item belonging to another session or tenant
- WHEN calling `discard_staged` with its id
- THEN `INVALID_REFERENCE` is returned and nothing is removed

### Requirement: Recall staging mix

`recall` MUST merge the caller's active-session staged items into results tagged `source:"staged"` (main results remain `source:"main"`). Staged items MUST be visible only to the caller's own tenant and session.

Source: write-path

#### Scenario: Staged visibility

- GIVEN staged items in the caller's session and in another project's session
- WHEN calling `recall`
- THEN only the caller's staged items appear, tagged `source:"staged"`

### Requirement: Write RBAC and audit

The `ToolName` union MUST include `remember`, `list_staged` and `discard_staged`, and the authorizer MUST require `contributor`, `project_admin` or `service_agent` for them, landed together so no build lets a viewer pass a write gate. A viewer MUST receive `PERMISSION_DENIED` with no tenant or resource detail. Every successful `remember` and `discard_staged` MUST record an `access_log` row via `AuditLogger.recordWrite` with `action='stage'`, the actor identity and a hash only (no raw content).

Source: write-path

#### Scenario: Viewer write

- GIVEN a viewer member
- WHEN calling any write tool
- THEN `PERMISSION_DENIED` is returned without detail

### Requirement: Inline secret scan, fail-closed

A synchronous inline secret scan MUST run before persisting any staging item. On a positive match or a scan error the write MUST be refused and no plaintext persisted. The scan MUST add no runtime dependency, and all SQL MUST be parameterized and tenant-scoped.

Source: write-path

#### Scenario: Secret in content

- GIVEN an item whose body contains a secret pattern
- WHEN calling `remember`
- THEN the write is refused and nothing is stored

### Requirement: Staging test coverage

A registration test MUST assert the 3 write tools appear via `InMemoryTransport` + `Client`. Handler tests with an in-memory staging fake MUST cover add, dedup, op/target validation, stale-to-uncertain, budget violation, secret-scan fail-closed, viewer denial and own-session-only list/discard. DB integration tests (skipped without `DATABASE_URL`) MUST assert the partial unique index, the op/target CHECK and `content_hash` dedup.

Source: write-path

#### Scenario: Suite green

- GIVEN no `DATABASE_URL`
- WHEN running `pnpm test`
- THEN unit tests pass and DB-gated tests skip cleanly

## History

None.
