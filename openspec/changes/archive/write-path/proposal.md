# Proposal — write-path (write-to-staging slice)

schema: proposal-v1
change: write-path
status: PROPOSED
date: 2026-07-30

## Problem

Agents can READ governed memory (`recall` / `get_memory` / `get_context`) but cannot yet
PROPOSE new memory. The design's second guiding principle — "agents propose, never write" —
is only half implemented: the propose half is missing. Without it the pilot cannot capture
decisions/gotchas/patterns produced during a session.

## Chosen approach

Implement the **write-to-staging slice**: the three write tools (`remember`, `list_staged`,
`discard_staged`) that write ONLY to a lazy-created staging session keyed `(project, repo,
branch)`, plus `recall` mixing in the caller's own staged items (`source:"staged"`). This is
the natural next link and reuses every established seam (repository pattern, tool
registration, `AppServices` injection, error opacity, audit). Promotion to main stays out of
scope — it happens later via a separate change (PR merge → judge → apply).

Rationale for the split: the promotion pipeline is heavy (GitHub Action OIDC, Bedrock judge,
sanitize, quarantine) and blocked on an open decision (quarantine retention) plus 4 schema
gaps. Shipping write-to-staging first delivers user value (agents can propose; humans can see
staged items) with zero new external dependencies.

## Scope

### IN scope
- **Migration 0003** — `staging_session` + `staging_item` tables from schema v2, adapted:
  numbered-migration format matching 0001/0002; `title`/`summary` enforced NOT NULL (contract
  requires them); partial unique index (one `open` session per key); op↔target CHECK;
  `UNIQUE(session_id, content_hash)`; budget CHECKs.
- **StagingRepository** (`src/db/stagingRepository.ts`) — interface + `PgImpl`, mirroring
  `MemoryRepository`: `findOrCreateOpenSession`, `insertStagingItem` (idempotent on
  content_hash), `listStagingItems`, `discardStagingItem`, and a `recall`-support query for
  staged items in the active session. All tenant-scoped.
- **Three write tools** — `remember`, `list_staged`, `discard_staged`: schemas in
  `schemas.ts`, handlers in `src/mcp/tools/`, registered via a new
  `registerWriteTools(server, deps)` called from `createMcpServer`.
- **RBAC write-role enforcement** — widen `ToolName` union AND extend `authorizer.ts` to
  require `contributor`/`service_agent` for write tools, **in the same change** (atomic; no
  window where viewers pass write gates).
- **AuditLogger.recordWrite** — new method logging `action:'stage'` to `access_log`.
- **AppServices/HandlerDeps/Deps triple-widening** for `stagingRepository`.
- **Sync secret-scan** — inline pattern-based pre-persist check (fail-closed); no external service.
- **`recall` staging-mix** — merge the caller's active-session staged items as `source:"staged"`.
- **Tests** — registration + handler + repository (integration, DB-gated) mirroring existing style.

### OUT of scope (→ future `promotion-pipeline` change)
- `POST /promote`, GitHub Action OIDC trigger, sanitize pipeline, Bedrock judge, quarantine table.
- Schema gaps for promotion: `promoted_at`/`promoted_memory_id`, `partially_promoted` status.
- Concurrency 3-way merge, Web UI uncertain queue, quarantine-retention decision.
- Service-agent (`machine_credential`) auth remains fail-CLOSED (unchanged).

## Constraints
- **pnpm-ONLY**; no new runtime deps (secret-scan is inline). Agents install `--frozen-lockfile`.
- Follow existing conventions: parameterized SQL, tenant scoping, error opacity (4 codes),
  budgets as DB CHECKs, FTS `english`, TDD (Vitest).
- Numbered migration must be reversible-safe and match the 0001/0002 pattern (idempotent-friendly, no seed coupling).
- Secure-by-default: RBAC enforced before any write; secret-scan fail-closed; no tenant/resource enumeration in errors.

## Affected Areas
| Area | Change |
|------|--------|
| `migrations/0003_staging.sql` | New staging tables + indexes + CHECKs |
| `src/db/stagingRepository.ts` | New repository (interface + PgImpl) |
| `src/mcp/tools/{remember,listStaged,discardStaged}.ts` | New handlers |
| `src/mcp/tools/{schemas,index}.ts` | Write schemas + `registerWriteTools` |
| `src/mcp/tools/recall.ts` | Staging-mix (`source:"staged"`) |
| `src/mcp/context.ts` | Widen ToolName + triple Deps widening |
| `src/auth/authorizer.ts` | Enforce write roles (contributor/service_agent) |
| `src/auth/auditLogger.ts` | `recordWrite` (action:'stage') |
| `src/security/*` | Inline secret-scan (fail-closed) |
| `tests/**` | Registration + handler + repository tests |

(≥ 3 affected areas → design phase REQUIRED, not skipped.)

## Rejected alternatives
- **Ship write-path + promotion together** — rejected: too large, pulls in Bedrock/OIDC/quarantine
  and an unresolved decision; violates incremental-change principle.
- **Write directly to `memory`** — rejected: violates the "agents propose, never write" principle.
- **Add an external secret-scanning dependency now** — rejected (YAGNI): inline pattern check
  suffices for the pilot; revisit if false-negative risk proves material.

## Open design decisions (for architect)
1. NOT NULL enforcement for `title`/`summary` at migration vs app layer (proposal leans: migration).
2. Secret-scan pattern set + fail-closed behavior shape (inline module contract).
3. Session-creation race: upsert `ON CONFLICT DO NOTHING` + re-select vs advisory lock.
4. One combined `StagingRepository` vs split session/item repositories (proposal leans: combined).
5. `fields jsonb` per-type validation location (handler vs schema) and how strict for the pilot.
