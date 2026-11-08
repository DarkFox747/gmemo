# Proposal: memory-lifecycle (C4) — HU-12, HU-11.4

## Intent
Memories must expire into "pending revalidation" (excluded from search) after `revalidate_at`, and the tech lead confirms or retires them; outcomes never expire. After a reverted PR, the tech lead retires all memories from that PR in bulk. This closes divergence 3 and prepares the `web_ui` provenance for C5.

## Scope

### In Scope
1. **Migrations**:
   - `0009_memory_enum_values.sql`: `ALTER TYPE memory_status ADD VALUE IF NOT EXISTS 'pending_revalidation'`, `ALTER TYPE provenance ADD VALUE IF NOT EXISTS 'web_ui'`. Own file; no use of the new values.
   - `0010_memory_lifecycle.sql`: `memory.revalidate_at timestamptz`, `retired_reason text`; backfill active non-outcome rows `revalidate_at = now() + 60 days`; partial index `(project_id, origin_pr) WHERE status='active'`; index for the sweep `(revalidate_at) WHERE status='active'`.
2. **Apply** (add/supersede insert, amend update, review approve via C2's shared core): `revalidate_at = now() + REVALIDATION_DAYS` (default 60, validated), NULL for `outcome`.
3. **Read-path audit**: tests per status (superseded, deprecated, pending_revalidation) for recall (lexical and semantic), get_memory (opaque INVALID_REFERENCE) and get_context.
4. **Job**: `POST /internal/jobs/revalidation-sweep` (C3 jobs router) + `pnpm job:revalidation`. Moves active rows with `revalidate_at < now()` to `pending_revalidation` (outcome excluded), returns the count, audited.
5. **API** (`/api/v1`, project_admin):
   - `GET /projects/:projectId/memories?status=pending_revalidation` (minimal list; C5 extends it with filters, search and pagination).
   - `POST …/memories/:id/confirm` → `active` + reset `revalidate_at` (pending only) + audit.
   - `POST …/memories/:id/retire {reason 3..500}` → `deprecated`, `retired_reason`, new revision (`op='deprecate'`, snapshot), audit. Allowed from active or pending.
   - `POST …/memories/retire-by-pr {originPr, reason}` → bulk retire of active/pending memories of that project with that `origin_pr`, one revision each, one txn; returns `{retired: n}`.

### Out of Scope
Direct create/edit (C5), web UI (C7).

## Decisions (auto mode)
- D1: retire reuses the existing deprecate revision pattern (`staging_op` has no `retire`). `promoted_from_item` is NULL and the actor is recorded in audit.
- D2: the confirm endpoint accepts only `pending_revalidation`; confirming an active memory → 404 (opaque, idempotent).
- D3: the sweep is idempotent and project-agnostic (a platform job); per-project counts are in the audit detail.

## Affected Areas
`migrations/`, `src/db/promotionRepository.ts` (apply), new `src/db/lifecycleRepository.ts`, `src/lifecycle/` service, `src/http/api/*`, `src/http/jobs.ts` (route), `src/config`, `src/index.ts`, `scripts/`, `package.json`, tests, docs.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Enum value used in the same txn | Med | Separate migration file; re-apply test |
| Bulk retire touches other projects | Low | `project_id` predicate + test |
| Dedup path leaves an old `revalidate_at` | Low | Documented; sweep handles it |

## Rollback Plan
Revert the commit. Enum values cannot be dropped, but they are unused by old code. Columns are nullable.

## Success Criteria
- [ ] HU-12.1–4 and HU-11.4 tests; per-status exclusion tests; suite, DB gate, lint, build, compose and smoke green.
