# Archive Report — Data Model (Change B)

schema: archive-report-v1
change: data-model
status: CLOSED
verdict: PASS
archived_at: 2026-07-30

## Outcome
The three MCP read tools now return real, project-scoped RDS memory data instead of stubs.
Landed migration `0002_memory.sql` (memory + memory_revision + memory_relation; content_tsv on
`english`; D8 composite + partial-ttl indexes), a `MemoryRepository` (recall FTS + time-decay +
keyset pagination; get_memory by opaque handle + relations + stale; get_context priority ordering +
budget + stale), a handle codec, a pure row→contract mapper, and the `AppServices` widening wiring.

## Pipeline
explore (2 agents) → proposal (D1–D8) → specs ∥ design → tasks (2 waves) → apply (3 workers)
→ verify (security + reviewer + build-worker) → remediation (1 worker) → archive.

## Requirements
All REQ-01..REQ-24 satisfied. See verify-report.md.

## Security
Every read still enforces the change-C two-gate + RBAC + audit chain. All SQL parameterized; strict
tenant scoping (cross-project handle → null → opaque error; relation joins re-scoped); handle/cursor
decode validated + opaque. 0 CRITICAL / 0 HIGH after remediation.

## Deferred → backlog
- Staging tables + recall staging-mix (source:"staged") — write-path change.
- Write tools (remember/list_staged/discard_staged), promotion/judge/quarantine.
- pgvector semantic search.
- M-01 rate limiting + L-02 helmet (need express-rate-limit, helmet).
- REQ-08 "memory_revision list" wording — accepted D9 YAGNI deviation (no history field).

## Notes
- FTS dictionary set to `english` (resolves the pilot-blocker); baked into a STORED generated column
  → must precede any real data write (it does — no data yet).
- Real end-to-end run requires a live Postgres with migrations applied → the dev-harness step.
