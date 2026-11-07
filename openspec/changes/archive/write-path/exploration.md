# Exploration — write-path (write-to-staging slice)

schema: exploration-synthesis-v1
change: write-path
date: 2026-07-30
agents: 2 (runtime seams · staging design)
status: COMPLETE

## Headline

The write path splits cleanly into **two changes**:

1. **write-to-staging slice (THIS change)** — `remember` / `list_staged` / `discard_staged`
   write to a lazy-created staging session keyed `(project, repo, branch)`; `recall`
   mixes in the caller's own staged items (`source:"staged"`). No Bedrock, no GitHub
   Action, no promotion. All tables already exist in schema v2.
2. **promotion pipeline (SEPARATE future change)** — PR-merge → OIDC → `POST /promote`
   → sanitize → Bedrock judge → idempotent apply / quarantine. Requires 4 schema gaps
   to be closed first (see below) and an open decision (quarantine retention 1 vs 2 mo).

## Runtime seams to mirror (agent A)

The read path is a clean layered stack; write tools imitate it exactly:

- **Tool def** → `ZodRawShape` exports in `src/mcp/tools/schemas.ts` (plain key→ZodType record, not `z.object()`).
- **Registration** → `src/mcp/tools/index.ts`: SDK callback ALWAYS destructures named args
  explicitly and re-assembles a typed contract Request (never forwards the raw args object —
  this is the historical cursor-forwarding bug). Add a parallel `registerWriteTools(server, deps)`.
- **6-step wrapper (identical to reads)**: authenticate → resolveTenant → authorize →
  build `RequestContext` → audit → handler; catch → `toToolErrorResult` (+ server-log if not `AppError`).
- **Handler** → pure `(input, ctx, deps): Promise<Response>` in `src/mcp/tools/<tool>.ts`.
- **Repository** → mirror `src/db/memoryRepository.ts`: interface first, `PgImpl` class with
  `private readonly pool: pg.Pool`, parameterized SQL constants, null-on-not-found, `AppError`
  on bad input, ALWAYS `project_id = $N` tenant-scoped.
- **Injection (triple widening, must be atomic)** → `src/mcp/context.ts`: widen `ToolName`
  union (l.59), `HandlerDeps` (l.119), `AppServices` (l.140), `Deps` (l.149) together, or the
  `Deps` spread at `transport.ts:51` breaks. `transport.ts` itself needs no change.
- **Handles** → `decodeHandle` throws `AppError(INVALID_REFERENCE)` on malformed; use for
  amend/supersede/deprecate `target_handle`.
- **Errors** → only 4 codes (`CONTEXT_UNAVAILABLE`, `PERMISSION_DENIED`, `INVALID_REFERENCE`,
  `INTERNAL`); never leak tenant/resource IDs.
- **Tests** → registration test via SDK `InMemoryTransport + Client → listTools()`; handler
  test via direct call with an `InMemoryStagingRepository` fake (template: `tests/memory/fakes.ts`).

## Staging design as specified (agent B)

- **Session key** `(project, repo, branch)`; ULID PK; lazy-created on first `remember`;
  partial unique index `WHERE status='open'` = exactly one open session per key; 7-day sliding TTL.
- **`remember(op, type, title, summary, body, fields?, target_handle?)`** — `op` is a
  caller *suggestion*; returns created staging_item `{id, state}`. `list_staged()` /
  `discard_staged(item_id)` operate on the caller's own session only.
- **op ↔ target symmetry (DB CHECK)**: `add` ↔ target NULL; `amend`/`supersede`/`deprecate` ↔ target NOT NULL.
- **Idempotent dedup**: `UNIQUE(session_id, content_hash)` → same content = no-op, not error.
- **RBAC**: writes require `contributor` or `service_agent`; reads require viewer+.
- **Budgets (DB CHECK + contract)**: title ≤ 120, summary ≤ 200, body ≤ 2000.
- **Sync secret-scan** BEFORE persisting any item (fail-closed).

## Cross-cutting gaps this change MUST resolve

1. **RBAC write-role gap** — `authorizer.ts` currently checks membership *existence* only, NOT
   role value (`_tool` unused). Viewers would pass write gates. Must widen `ToolName` AND enforce
   `contributor`/`service_agent` for write tools **atomically** (widening-before-enforcement = a hole).
2. **AuditLogger** — only has `recordRead()`; needs `recordWrite()` (action `'stage'`) or writes mis-label the trail.
3. **staging_item.title / .summary nullable in v2 DDL** but the contract requires them — enforce
   NOT NULL in migration 0003 (or app-layer). **Design decision for architect.**
4. **Secret-scan implementation** unspecified — inline regex/pattern vs external service.
   YAGNI for pilot: inline pattern-based scan. **Design decision for architect.**
5. **Session-creation race** — two parallel `remember` on same key race on INSERT; partial unique
   index protects at DB level, but the app upsert/retry pattern must be specified.

## Explicitly OUT of scope (→ separate promotion-pipeline change)

- `POST /promote`, GitHub Action OIDC trigger, sanitize pipeline, Bedrock judge, quarantine.
- Schema gaps for promotion: `promoted_at` / `promoted_memory_id`, `partially_promoted` status, quarantine table.
- Concurrency reconciliation (3-way merge), Web UI uncertain queue.
- Open decision: quarantine retention (1 vs 2 months) — not needed for this slice.

## Risks carried into design

- Triple-widening + RBAC enforcement must land atomically (auth hole otherwise).
- `content_tsv` uses `'english'` in migration 0002 (resolved) — staging recall-mix must match.
- `op` suggestion vs judge reclassification: no `judge_op` column in v2 — irrelevant to this slice (no judge yet), note for promotion change.
- `fields jsonb` has no DB-level per-type validation — must validate server-side in `remember` handler per the 7 memory types (docs/05).
