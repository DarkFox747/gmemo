# Exploration: memory-lifecycle (C4)

One crombie-explore scope (memory lifecycle + read-path exclusions). Status: COMPLETE.

- `memory_status` = {active, superseded, deprecated} (`migrations/0002_memory.sql:21`). `provenance` = {pr_reviewed, manual_ui}; **no `web_ui`** (`:26`). The only writer hardcodes `pr_reviewed` (`src/db/promotionRepository.ts:224`).
- Every read predicate is a literal `status = 'active'`: recall page/count, recallSemantic, get_memory row and relations, context phase 1/2, judge context (`src/db/memoryRepository.ts:243,259,272,285,297,309,321`; `promotionRepository.ts:203`). A new status is excluded automatically. **Test gap**: no per-status tests for recall/semantic/get_memory (deprecated/pending) and no pending tests anywhere (`tests/memory/*`).
- `get_memory` on a non-active handle → opaque `INVALID_REFERENCE` (`src/mcp/tools/getMemory.ts:37-43`). The `get_context` stale marker is TTL-based only.
- Deprecate apply = lock target FOR UPDATE (status/revision/project guard), `UPDATE status='deprecated', current_revision+1`, `INSERT memory_revision(op='deprecate', snapshot, promoted_from_item nullable)`. No relation, no content/embedding change (`promotionRepository.ts:307-329, 699-728`). This is the template for retire. `staging_op` has no `retire` value, so retire reuses `deprecate`.
- `content_tsv` is GENERATED (never written). The embedding is untouched on deprecate.
- `revalidate_at` set points: `INSERT_MEMORY_SQL` (add/supersede, `:218-227`), `UPDATE_MEMORY_AMEND_SQL` (`:260-267`). Dedup `ON CONFLICT DO NOTHING` leaves the existing row's value unchanged.
- `origin_pr int` nullable, **no index** (`0002:70,84-89`). retire-by-pr needs a partial index `(project_id, origin_pr) WHERE status='active'`.
- Migration runner: one txn per file, so `ADD VALUE` goes in its own file and the value must not be used in the same file (`src/db/migrate.ts:79-83`, `0004:9-11`).
- No job/internal-route precedent. Scripts: `migrate`, `smoke`. C3 also introduces jobs (quarantine purge) and owns `0008`.
