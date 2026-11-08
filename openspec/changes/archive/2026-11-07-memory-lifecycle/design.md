# Design: Memory lifecycle — revalidation, retire, retire-by-PR (C4) — HU-12, HU-11.4

## Technical Approach

C4 adds one memory state (`pending_revalidation`), two columns (`revalidate_at`, `retired_reason`), and a small lifecycle slice on top of the seams C1–C3 deliver. It needs no new runtime dependency.

- **Schema**: `0009` adds only the enum values. `0010` adds the columns, the backfill, a CHECK and two partial indexes. The runner wraps each file in its own transaction (`src/db/migrate.ts:79-83`), so the new enum values are committed before `0010` uses them.
- **Apply**: `INSERT_MEMORY_SQL` (used by add and supersede) and `UPDATE_MEMORY_AMEND_SQL` in `src/db/promotionRepository.ts` compute `revalidate_at` in SQL from a new `$13 = revalidationDays`, and set NULL when the type is `outcome`. Promotion, C2 review approve and C3 restore all go through C2's shared `applyOpInTxn`. Changing these two statements therefore covers every write path, and no second code path is added.
- **Read path**: no SQL changes. Every read predicate is already the literal `status = 'active'` (`memoryRepository.ts:243,259,272,285,297,309,321`, judge context `promotionRepository.ts:203`), so `pending_revalidation` is excluded automatically. C4 adds the per-status tests that prove it: unit fakes plus a DB-gated suite.
- **Lifecycle writes**: a new `src/db/lifecycleRepository.ts` holds five statements (list, confirm, retire one, retire by PR, sweep). Each is a single, self-contained SQL statement: a guarded `UPDATE`, or a data-modifying CTE that locks, updates and writes the revision atomically. No multi-statement transaction choreography is needed.
- **Service**: `src/lifecycle/lifecycleService.ts` maps rows to DTOs. It applies C2's reason policy (secret scan → 400, PII mask) and turns the sweep result into C3's `JobResult`.
- **HTTP**: `src/http/api/memoryRoutes.ts` adds four routes to C2's nested project router (apiAuth → projectAdmin → uuid → zod → service → `recordApi`). The job `revalidation-sweep` is registered in C3's jobs map in `src/index.ts`. `scripts/jobs/revalidation.ts` and `pnpm job:revalidation` call the same service method.

**Spec / proposal alignment notes (for the orchestrator)**:
- Proposal item 1 asks for the retire-by-pr index `(project_id, origin_pr) WHERE status='active'`. Retire-by-pr also targets `pending_revalidation` rows, and those would fall outside that partial predicate. This design uses `WHERE origin_pr IS NOT NULL` instead, which serves both statuses (see Decision 1). The sweep index stays exactly as proposed.
- No HU-12 text exists in the repo. Test Strategy assumes HU-12.1 = expiry to pending (sweep), HU-12.2 = pending excluded from reads, HU-12.3 = confirm, HU-12.4 = retire, and HU-11.4 = bulk retire after a reverted PR. Correct the mapping if the HU doc differs.
- Spec deltas needed: `memory-read` (no read tool returns `pending_revalidation`; line 107 currently lists only superseded/deprecated), `promotion` (apply sets `revalidate_at`) and the new `memory-lifecycle` capability (API + job).
- Hard ordering: C4 depends on C2 being implemented (`src/http/api/*`, `ApiAction`, `recordApi`, `applyOpInTxn`) and on C3's `src/jobs/jobsRouter.ts` (`JobResult`, `makeJobsRouter`, the script pattern). Neither exists in `src/` today.

## Architecture Decisions

### Decision 1: Two migrations — 0009 enum values only, 0010 columns / backfill / indexes

**Choice**:

```sql
-- migrations/0009_memory_enum_values.sql
-- Migration 0009: memory lifecycle enum values (C4).
-- ONLY ADD VALUE statements. The new values are NOT used in this file: PG16 allows
-- ADD VALUE inside the runner's per-file transaction, but a value added in a
-- transaction cannot be used before that transaction commits (0004 precedent).
-- IF NOT EXISTS makes re-application a no-op.
ALTER TYPE memory_status ADD VALUE IF NOT EXISTS 'pending_revalidation';
ALTER TYPE provenance    ADD VALUE IF NOT EXISTS 'web_ui';   -- written by C5 (direct create/edit)
```

```sql
-- migrations/0010_memory_lifecycle.sql
-- Migration 0010: memory lifecycle columns, backfill and indexes (C4).
-- Additive and idempotent. Depends on 0009 (already committed by the runner).

ALTER TABLE memory ADD COLUMN IF NOT EXISTS revalidate_at  timestamptz;  -- NULL = never expires (outcome / non-active)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS retired_reason text;         -- set only by retire / retire-by-pr

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ck_memory_retired_reason_len'
                   AND conrelid = 'memory'::regclass) THEN
    ALTER TABLE memory ADD CONSTRAINT ck_memory_retired_reason_len
      CHECK (retired_reason IS NULL OR char_length(retired_reason) BETWEEN 3 AND 500);
  END IF;
END $$;

-- Backfill: existing active non-outcome memories get a 60-day window. The value is
-- fixed (a migration cannot read REVALIDATION_DAYS). The IS NULL guard keeps it idempotent.
UPDATE memory
SET revalidate_at = now() + interval '60 days'
WHERE status = 'active' AND type <> 'outcome' AND revalidate_at IS NULL;

-- Retire-by-PR lookup. It covers active AND pending_revalidation rows: origin_pr = $n
-- implies origin_pr IS NOT NULL, so the planner can use this partial index.
CREATE INDEX IF NOT EXISTS ix_memory_proj_origin_pr
  ON memory (project_id, origin_pr) WHERE origin_pr IS NOT NULL;

-- Revalidation sweep (status='active' AND revalidate_at < now()).
CREATE INDEX IF NOT EXISTS ix_memory_revalidate_due
  ON memory (revalidate_at) WHERE status = 'active';
```

**Alternatives considered**:
- (a) One migration file. Rejected: the runner wraps each file in one transaction, so using `pending_revalidation` (for example in an index predicate or the backfill) in the same file fails.
- (b) The proposed index `WHERE status='active'`. Rejected: pending rows are retire-by-pr targets too, and they would fall back to `ix_memory_proj_status`. `origin_pr IS NOT NULL` is smaller (most memories lack a PR) and covers both statuses.
- (c) A `retired_at` column. Rejected (YAGNI): the `deprecate` revision's `created_at` and the audit row already timestamp the retire.

**Rationale**: Follows the 0004/0007 idempotency patterns. A re-apply test runs both files twice. Old code ignores nullable columns and unused enum values.

**Reversible**: Partial. The columns, CHECK and indexes can be dropped manually. Enum values cannot be dropped without rebuilding the type, but old code never reads them (proposal rollback plan).

### Decision 2: `revalidate_at` is computed in SQL at apply; `REVALIDATION_DAYS` is passed to the repository constructor

**Choice**:
- Config: `REVALIDATION_DAYS: z.coerce.number().int().min(1).max(3650).default(60)`. This follows the `SEMANTIC_FALLBACK_*` pattern. `''` coerces to 0 and fails `min(1)`, so an empty value fails fast too.
- `PgPromotionRepository` becomes `constructor(pool: pg.Pool, opts: { revalidationDays: number })`. The constructor throws if the value is not an integer ≥ 1 (defence in depth for tests and scripts that bypass `loadConfig`). The only construction sites are `src/index.ts:114` and `tests/db/promotion.integration.test.ts:208`.
- Exact SQL changes. Placeholders `$1..$12` are unchanged and `$13` is appended:

```sql
-- INSERT_MEMORY_SQL (add + supersede). $13 = revalidation_days (int)
INSERT INTO memory
  (project_id, repo_id, type, title, summary, body, fields,
   status, provenance, author_identity, content_hash, current_revision,
   origin_branch, origin_pr, embedding, revalidate_at)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
        'active', 'pr_reviewed', $8, $9, 1, $10, $11, $12::vector,
        CASE WHEN $3::memory_type = 'outcome' THEN NULL
             ELSE now() + make_interval(days => $13::int) END)
ON CONFLICT (project_id, content_hash) DO NOTHING
RETURNING id
```

```sql
-- UPDATE_MEMORY_AMEND_SQL. $13 = revalidation_days (int). Amend may change the type
-- ($5), so the CASE uses the NEW type: outcome→NULL, otherwise a fresh window.
UPDATE memory
SET title = $1, summary = $2, body = $3, fields = $4::jsonb, type = $5,
    content_hash = $6, author_identity = $7, provenance = 'pr_reviewed',
    origin_branch = $8, origin_pr = $9, embedding = $12::vector,
    revalidate_at = CASE WHEN $5::memory_type = 'outcome' THEN NULL
                         ELSE now() + make_interval(days => $13::int) END,
    current_revision = current_revision + 1, updated_at = now()
WHERE id = $10 AND project_id = $11
```

- Both call sites inside `applyOpInTxn` (A1 add, S2 supersede, M2 amend) append `this.revalidationDays` as the 13th parameter.
- Deprecate (D1–D3), `UPDATE_MEMORY_SUPERSEDED_SQL` and C2's R8 do not touch `revalidate_at`: non-active rows are never swept or read.
- **Dedup** (`ON CONFLICT DO NOTHING`) leaves the existing row's `revalidate_at` and `status` unchanged. This is documented, and the sweep handles it. Known limitation, not in scope: re-adding content byte-identical to a `pending_revalidation` or `deprecated` memory dedupes to that row (the pre-existing `UNIQUE(project_id, content_hash)` semantics).
- A `pending_revalidation` target makes amend/supersede/deprecate `stale` (the lock checks `status = 'active'`). Under C1 the item then goes to the review queue. In C2's detail it shows as `targetStale`, and approve returns 409 `target_inactive`, so the tech lead confirms the memory first. This is the intended behaviour.

**Alternatives considered**:
- (a) Compute the timestamp in TypeScript and pass a `Date`. Rejected: it mixes the app clock with the DB clock, while the sweep compares against `now()`.
- (b) A DB `DEFAULT` or trigger. Rejected: the window is a config value, and a trigger hides logic from the single apply path.
- (c) Pass `revalidationDays` through `ApplyContext`. Rejected: it is process-level config, not per-item context, and it would change C2's and C3's call sites for no gain.

**Rationale**: One place sets the value. The DB clock is shared with the sweep. Review approve and restore get it for free through `applyOpInTxn`.

**Reversible**: Yes.

### Decision 3: Lifecycle writes are single-statement, project-guarded SQL in `LifecycleRepository`

**Choice**: `src/db/lifecycleRepository.ts`. Every statement except the platform sweep carries `project_id = $1`.

```sql
-- LIST  $1 project_id  $2 status (memory_status)  $3 limit+1   (uses ix_memory_proj_status)
SELECT id, type, title, summary, status, current_revision, origin_branch, origin_pr,
       revalidate_at, updated_at
FROM memory
WHERE project_id = $1 AND status = $2::memory_status
ORDER BY revalidate_at ASC NULLS LAST, id ASC
LIMIT $3                                   -- rows > limit → truncated = true, extra row dropped

-- CONFIRM  $1 project_id  $2 memory_id  $3 revalidation_days
-- The guard is the WHERE clause: an active, deprecated, superseded or foreign row → 0 rows → 404 (D2).
-- The content is unchanged, so there is no revision and no updated_at bump: handles stay valid.
UPDATE memory
SET status = 'active',
    revalidate_at = CASE WHEN type = 'outcome' THEN NULL
                         ELSE now() + make_interval(days => $3::int) END,
    reviewed_at = now()
WHERE id = $2 AND project_id = $1 AND status = 'pending_revalidation'
RETURNING id, revalidate_at
```

Retire one and retire by PR share one tail (module constant `RETIRE_TAIL_SQL`, concatenated). It locks the target rows in id order, flips them, and writes one `deprecate` revision per row from the post-update `RETURNING` (new `current_revision`, unchanged content):

```sql
-- RETIRE_ONE    $1 project_id  $2 memory_id  $3 reason  $4 actor_identity
-- RETIRE_BY_PR  $1 project_id  $2 origin_pr  $3 reason  $4 actor_identity
WITH target AS (
  SELECT id FROM memory
  WHERE project_id = $1
    AND id = $2::uuid                 -- RETIRE_BY_PR: AND origin_pr = $2::int
    AND status IN ('active', 'pending_revalidation')
  ORDER BY id
  FOR UPDATE
),
-- RETIRE_TAIL_SQL ↓
upd AS (
  UPDATE memory m
  SET status = 'deprecated', retired_reason = $3, revalidate_at = NULL,
      current_revision = m.current_revision + 1, updated_at = now()
  FROM target t
  WHERE m.id = t.id AND m.project_id = $1
  RETURNING m.id, m.current_revision, m.title, m.summary, m.body, m.fields, m.type, m.content_hash
)
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
SELECT id, current_revision, 'deprecate', title, summary, body, fields, type,
       content_hash, $4, NULL
FROM upd
RETURNING memory_id, revision_no
```

- Retire one: 0 rows → `null` (404). 1 row → `{ memoryId, revision }`.
- Retire by PR: `{ retired: rowCount, memoryIds }`. 0 is a valid answer, and a repeat returns 0 (idempotent).
- **Concurrency**: `FOR UPDATE` in the CTE takes row locks. Under READ COMMITTED, a concurrent retire, confirm, sweep or promotion deprecate waits and then re-evaluates its own predicate on the new row version: `status IN (…)`, `status = 'pending_revalidation'`, or `status = 'active'` respectively. The first writer wins and the loser affects 0 rows. The one-statement CTE is atomic, which satisfies "one transaction, one revision each" for the bulk case.
- `author_identity = actor.actorId` (idp_subject), the same meaning as everywhere else in `memory_revision`. `promoted_from_item` is NULL (proposal D1). The reason is stored only in `memory.retired_reason`, never in the revision or the audit row.

```sql
-- SWEEP (platform job, project-agnostic, D3). Strict "<": a row due exactly now is swept next run.
WITH swept AS (
  UPDATE memory
  SET status = 'pending_revalidation'
  WHERE status = 'active' AND type <> 'outcome'
    AND revalidate_at IS NOT NULL AND revalidate_at < now()
  RETURNING project_id
)
SELECT project_id, count(*)::int AS n FROM swept GROUP BY project_id
```

The sweep leaves `revalidate_at` in place, so the list query can show "expired on", and `updated_at` unchanged, because content is unchanged. A concurrent amend holds the row lock and resets `revalidate_at`. The sweep then re-checks the predicate after the amend commits and skips the row.

```ts
export type MemoryStatus = 'active' | 'superseded' | 'deprecated' | 'pending_revalidation';
export interface MemoryListRow {
  id: string; type: MemoryType; title: string; summary: string; status: MemoryStatus;
  current_revision: number; origin_branch: string | null; origin_pr: number | null;
  revalidate_at: Date | null; updated_at: Date;
}
export interface LifecycleRepository {
  listMemories(projectId: string, q: { status: MemoryStatus; limit: number }):
    Promise<{ rows: MemoryListRow[]; truncated: boolean }>;
  confirm(projectId: string, memoryId: string): Promise<{ memoryId: string; revalidateAt: Date | null } | null>;
  retire(projectId: string, memoryId: string, reason: string, actorIdentity: string):
    Promise<{ memoryId: string; revision: number } | null>;
  retireByPr(projectId: string, originPr: number, reason: string, actorIdentity: string):
    Promise<{ retired: number; memoryIds: string[] }>;
  sweepExpired(): Promise<Array<{ projectId: string; count: number }>>;
}
export class PgLifecycleRepository implements LifecycleRepository {
  constructor(pool: pg.Pool, opts: { revalidationDays: number });   // same ctor guard as Decision 2
}
```

**Alternatives considered**:
- (a) Put the methods on `PgPromotionRepository` and reuse `LOCK_MEMORY_FOR_DEPRECATE_SQL`/`INSERT_REVISION_DEPRECATE_SQL`. Rejected: that repository is the staging→memory pipeline seam. Lifecycle actions are human/admin and have no staging item. Exporting private SQL to a second file would couple them for a three-line statement.
- (b) Multi-statement BEGIN / SELECT FOR UPDATE / UPDATE / INSERT per row, looped for retire-by-pr. Rejected: N round trips and more failure modes. The CTE does the same locking and writes atomically.
- (c) Confirm writes a revision. Rejected: `staging_op` has no `confirm` value and the content does not change. Bumping `current_revision` would invalidate every outstanding handle for no reason. The audit row records the confirm.

**Rationale**: The project guard sits in every statement. First-writer-wins comes from row locks with no new schema. Each method is one round trip.

**Reversible**: Yes (internal interface; data follows the normal lifecycle).

### Decision 4: `LifecycleService` applies C2's reason policy and owns the job result shape

**Choice** (`src/lifecycle/lifecycleService.ts`; types in `src/lifecycle/types.ts`, so contracts land before the implementation):

```ts
// src/lifecycle/types.ts
import type { JobResult } from '../jobs/jobsRouter.js';          // C3
export type ConfirmOutcome  = { kind: 'confirmed'; dto: ConfirmResponseDto } | { kind: 'not_found' };
export type RetireOutcome   = { kind: 'retired'; dto: RetireResponseDto } | { kind: 'not_found' } | { kind: 'invalid_reason' };
export type RetireByPrOutcome = { kind: 'retired'; dto: RetireByPrResponseDto } | { kind: 'invalid_reason' };
export interface LifecycleServiceLike {
  list(projectId: string, q: MemoryListQueryInput): Promise<MemoryListDto>;
  confirm(actor: AdminActor, projectId: string, memoryId: string): Promise<ConfirmOutcome>;
  retire(actor: AdminActor, projectId: string, memoryId: string, reason: string): Promise<RetireOutcome>;
  retireByPr(actor: AdminActor, projectId: string, originPr: number, reason: string): Promise<RetireByPrOutcome>;
  sweep(): Promise<JobResult>;   // { job: 'revalidation-sweep', count: total, detail: { [projectId]: n } }
}
export const REVALIDATION_SWEEP_JOB = 'revalidation-sweep';
```

- Reason handling (retire and retire-by-pr) is identical to C2 `reject`. The body is already zod-validated (trim, 3..500).
  - `scanForSecrets(reason).length > 0` → `invalid_reason` (400). The reason is never stored or echoed, and it is checked before any DB call.
  - `reason = maskPii(reason).text`. If masking pushes the reason past 500, it is clamped to 500, matching the C1 budget clamp. The DB CHECK is the backstop.
- `sweep()` builds `detail` from the per-project counts and `count` from their sum. It is idempotent: a second run returns `count: 0, detail: {}`. The job never throws on 0. A DB error propagates to C3's router, which reports and logs it. The error is not swallowed.
- DTO mapping: `version = current_revision`, timestamps as ISO strings.

**Alternatives considered**: routes calling the repository directly. Rejected: the secret/PII reason policy and the job result shape would be duplicated across route, job and script. This also mirrors C2's `ReviewService`.

**Rationale**: Thin, unit-testable orchestration with fakes. Routes own audit, as in C2.

**Reversible**: Yes.

### Decision 5: Routes on C2's nested project router; uniform 404; audit via `recordApi` with four new `ApiAction` values

**Choice** (`src/http/api/memoryRoutes.ts` exports `makeMemoryRoutes(deps: { lifecycleService: LifecycleServiceLike; auditLogger: AuditLogger }): express.Router`, mounted by `router.ts` on the nested `/v1/projects/:projectId` router behind `projectAdmin`):

| Method + path (under `/api/v1/projects/:projectId`) | Chain | Success | Audit (`recordApi`) |
|---|---|---|---|
| `GET /memories` | zod query → `list` | 200 `MemoryListDto` | `memories.list` `{status, resultCount}` |
| `POST /memories/retire-by-pr` | zod body → `retireByPr` | 200 `{retired: n}` (0 allowed) | `memory.retire_by_pr` `{originPr, resultCount: n}` |
| `POST /memories/:memoryId/confirm` | uuid → zod empty body → `confirm` | 200 `ConfirmResponseDto` | `memory.confirm` `{memoryId}` |
| `POST /memories/:memoryId/retire` | uuid → zod body → `retire` | 200 `RetireResponseDto` | `memory.retire` `{memoryId}` |

```ts
export const MemoryListQuery = z.object({
  status: z.enum(['pending_revalidation']).default('pending_revalidation'),   // C5 widens this enum
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();
const ConfirmBody    = z.object({}).strict();                                 // undefined body → {}
const RetireBody     = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const RetireByPrBody = z.object({
  originPr: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
}).strict();
```

- Order is apiAuth → projectAdmin → uuid (`z.string().uuid()` on `:memoryId`; failure → `AppError(NOT_FOUND)`) → zod (failure → `INVALID_REQUEST`) → service. A non-admin never reaches validation and gets the same 404 (C2 rule).
- `not_found` → `AppError(NOT_FOUND)`. This covers absent, foreign project, wrong status (confirm on active, D2; retire on deprecated or superseded) and repeats, all as byte-identical `{"error":"Not found"}`. `invalid_reason` → `AppError(INVALID_REQUEST)` → 400.
- Audit runs after success only (C2). Denials, 404s and 400s are never audited.
- `ApiAction` gains `'memories.list' | 'memory.confirm' | 'memory.retire' | 'memory.retire_by_pr'`.
- `ApiAuditDetail` gains `status?: string; originPr?: number`. `memoryId` and `resultCount` already exist. The reason is never in the audit detail.
- `RdsAuditLogger.recordApi` changes C2's inline `action ∈ {approve, reject}` test to a module set `WRITE_API_ACTIONS: ReadonlySet<ApiAction> = new Set(['review_queue.approve', 'review_queue.reject', 'memory.confirm', 'memory.retire', 'memory.retire_by_pr'])`. Members map to `access_log.action = 'update'`, everything else to `'read'`. No new `access_action` enum value is needed.

**Alternatives considered**:
- (a) `PATCH /memories/:id {status}`. Rejected: confirm and retire have different guards and payloads, and the proposal fixes these paths.
- (b) Return 404 when retire-by-pr matches 0 rows. Rejected: the caller is a proven admin, 0 is a truthful idempotent answer, and the UI must be able to report "nothing to retire".

**Rationale**: It reuses C2's chain, error mapper and audit unchanged in behaviour. Only the union and the write-action set grow.

**Reversible**: Yes.

### Decision 6: Job wiring through C3's jobs router; script reuses the same service method

**Choice**:
- In `src/index.ts`, the jobs map passed to C3's `makeJobsRouter` gains `[REVALIDATION_SWEEP_JOB]: () => lifecycleService.sweep()`. Auth (token / dev enablement), the opaque 404 when disabled, and the audit row (with `JobResult`, including per-project `detail`) are all C3's router responsibilities. C4 adds no job-specific HTTP code.
- `scripts/jobs/revalidation.ts` follows C3's `scripts/jobs/<name>.ts` pattern exactly (same pool bootstrap from `DATABASE_URL`, same audit helper, JSON `JobResult` on stdout, exit code 1 on error with the error logged). It builds `PgLifecycleRepository(pool, { revalidationDays })` and calls `LifecycleService.sweep()`. The sweep never reads `revalidationDays`. The script reads `REVALIDATION_DAYS` with the same zod field (exported as `revalidationDaysSchema` from `src/config/index.ts`), so it does not need the full Cognito/Bedrock config.
- `package.json`: `"job:revalidation": "tsx scripts/jobs/revalidation.ts"`.
- EventBridge scheduling is documented (daily), not implemented, the same as C3.

**Alternatives considered**: a separate `/internal/revalidation` route. Rejected: C3 already defines the single jobs surface (proposal C3 D4).

**Reversible**: Yes.

## Data Flow

```
apply (promotion | C2 approve | C3 restore) ─▶ applyOpInTxn
     add/supersede: INSERT_MEMORY_SQL      ┐  revalidate_at = outcome ? NULL : now() + REVALIDATION_DAYS
     amend:         UPDATE_MEMORY_AMEND_SQL ┘

EventBridge (doc) / pnpm job:revalidation / POST /internal/jobs/revalidation-sweep (C3 router: token, audit)
     ─▶ LifecycleService.sweep ─▶ SWEEP: active ∧ type≠outcome ∧ revalidate_at<now() ─▶ pending_revalidation
     ─▶ JobResult { job, count, detail{projectId:n} }

MCP reads (recall BM25 + semantic, get_memory, get_context, judge context): status='active' ⇒ pending/deprecated/superseded invisible

Web (C7) ─▶ /api ─▶ apiAuth ─▶ /v1/projects/:projectId ─▶ projectAdmin ─(deny)─▶ 404
     GET  /memories?status=pending_revalidation ─▶ LIST ─────────────────────────▶ recordApi(memories.list, read)
     POST /memories/:id/confirm ─▶ CONFIRM (guard status=pending) ─0 rows─▶ 404 ─▶ recordApi(memory.confirm, update)
     POST /memories/:id/retire  ─▶ secretScan/maskPii ─▶ RETIRE_ONE (CTE: lock→deprecated→revision)
     POST /memories/retire-by-pr ─▶ secretScan/maskPii ─▶ RETIRE_BY_PR (CTE, N revisions, 1 statement) ─▶ {retired:n}

     active ──sweep──▶ pending_revalidation ──confirm──▶ active
        │                     │
        └──────retire─────────┴──────▶ deprecated (+ revision op='deprecate', retired_reason)
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `memory_status.pending_revalidation`, `provenance.web_ui` | DB enum | `migrations/0009_memory_enum_values.sql` | `src/db/lifecycleRepository.ts`; C5 (`web_ui` on direct create/edit) |
| `memory.revalidate_at`, `memory.retired_reason` | DB column | `migrations/0010_memory_lifecycle.sql` | `src/db/promotionRepository.ts`, `src/db/lifecycleRepository.ts`; C5 (list filters/detail) |
| `Config.REVALIDATION_DAYS`, `revalidationDaysSchema` | config | `src/config/index.ts` | `src/index.ts`, `scripts/jobs/revalidation.ts` |
| `PgPromotionRepository(pool, { revalidationDays })` | class ctor | `src/db/promotionRepository.ts` | `src/index.ts`, `tests/db/promotion.integration.test.ts`; C3 restore (same instance) |
| `MemoryStatus`, `MemoryListRow`, `LifecycleRepository`, `PgLifecycleRepository` | type / interface / class | `src/db/lifecycleRepository.ts` | `src/lifecycle/lifecycleService.ts`, `src/http/api/types.ts`, `src/index.ts`, `scripts/jobs/revalidation.ts`; C5 extends `listMemories` |
| `LifecycleServiceLike`, `ConfirmOutcome`, `RetireOutcome`, `RetireByPrOutcome`, `REVALIDATION_SWEEP_JOB` | interface / type / const | `src/lifecycle/types.ts` | `src/lifecycle/lifecycleService.ts`, `src/http/api/memoryRoutes.ts`, `src/mcp/context.ts`, `src/index.ts`, `tests/auth/fakes.ts` |
| `LifecycleService` | class | `src/lifecycle/lifecycleService.ts` | `src/index.ts`, `scripts/jobs/revalidation.ts` |
| `JobResult`, `makeJobsRouter` | type / func | `src/jobs/jobsRouter.ts` (C3) | `src/lifecycle/types.ts`, `src/index.ts` |
| `ApiAction` += `memories.list`, `memory.confirm`, `memory.retire`, `memory.retire_by_pr`; `ApiAuditDetail` += `status`, `originPr` | type | `src/mcp/context.ts` (C2) | `src/http/api/memoryRoutes.ts`, `src/auth/auditLogger.ts` |
| `AppServices.lifecycleService`, `ApiRouterDeps.lifecycleService` | type | `src/mcp/context.ts`, `src/http/api/types.ts` | `src/index.ts`, `src/http/api/router.ts`, `tests/http/api/helpers.ts` |
| `MemoryListDto`, `MemoryListItemDto`, `MemoryListQueryInput`, `ConfirmResponseDto`, `RetireResponseDto`, `RetireByPrResponseDto`; `MemoryRefDto.status: MemoryStatus` (widened) | type | `src/http/api/types.ts` | `src/lifecycle/lifecycleService.ts`, `src/http/api/memoryRoutes.ts`, `src/review/reviewService.ts` (C2 refs), `packages/web` (C7) |
| `MemoryListQuery` (zod) | schema | `src/http/api/memoryRoutes.ts` | C5 (widens `status`, adds filters/search/cursor) |
| `GET/POST /api/v1/projects/:projectId/memories[...]` | endpoint | `src/http/api/memoryRoutes.ts` | `packages/web` (C7); C5 extends `GET /memories` |
| `POST /internal/jobs/revalidation-sweep` | endpoint | `src/index.ts` (jobs map, C3 router) | EventBridge (doc), operators |

DTO shapes (exact, camelCase JSON, ISO-8601 strings):

```ts
interface MemoryListItemDto { id: string; type: MemoryType; title: string; summary: string;
  status: MemoryStatus; version: number; originBranch: string | null; originPr: number | null;
  revalidateAt: string | null; updatedAt: string }
interface MemoryListDto { items: MemoryListItemDto[]; truncated: boolean }
interface MemoryListQueryInput { status: 'pending_revalidation'; limit: number }
interface ConfirmResponseDto { memoryId: string; status: 'active'; revalidateAt: string | null }
interface RetireResponseDto { memoryId: string; status: 'deprecated'; version: number }
interface RetireByPrResponseDto { retired: number }
```

## File Changes

Prerequisite: C2 and C3 are implemented. Batches: **A** first. Then **B**, **C** and **D** in parallel. **E** needs C. **F** needs B, C and E. **G** (docs) runs with F. No file appears in two batches.

| File | Action | Description |
|------|--------|-------------|
| **A — Schema, config, contracts** | | |
| `migrations/0009_memory_enum_values.sql` | Create | Two `ADD VALUE IF NOT EXISTS` (SQL in Decision 1) |
| `migrations/0010_memory_lifecycle.sql` | Create | Columns, CHECK, backfill, two indexes (SQL in Decision 1) |
| `src/config/index.ts` | Modify | `REVALIDATION_DAYS` (int 1..3650, default 60); export `revalidationDaysSchema` |
| `src/lifecycle/types.ts` | Create | `LifecycleServiceLike`, outcomes, `REVALIDATION_SWEEP_JOB` |
| `src/db/lifecycleRepository.ts` | Create | Types only in A (`MemoryStatus`, `MemoryListRow`, `LifecycleRepository`); the Pg class is added in C |
| `src/mcp/context.ts` | Modify | `ApiAction` += 4 values; `ApiAuditDetail` += `status`, `originPr`; `AppServices.lifecycleService` |
| `src/http/api/types.ts` | Modify | Lifecycle DTOs; `ApiRouterDeps.lifecycleService`; `MemoryRefDto.status: MemoryStatus` |
| `tests/auth/fakes.ts` | Modify | `makeStubAuthServices`: `lifecycleService` stub |
| `tests/config/revalidationConfig.test.ts` | Create | Default 60; `0`, `-1`, `1.5`, `abc`, `''`, `3651` → exit(1); `30` accepted |
| `tests/db/lifecycle.migrate.integration.test.ts` | Create | DB-gated: enum values present; columns + CHECK + indexes exist; backfill sets active non-outcome only (outcome, deprecated stay NULL); executing 0009 and 0010 SQL a second time is a no-op |
| **B — Apply sets `revalidate_at`** | | |
| `src/db/promotionRepository.ts` | Modify | Ctor `opts.revalidationDays` + guard; `$13` in `INSERT_MEMORY_SQL` / `UPDATE_MEMORY_AMEND_SQL` (Decision 2); pass it at A1, S2, M2 |
| `tests/db/promotion.integration.test.ts` | Modify | Ctor arg; add → `revalidate_at ≈ now()+N d`; outcome add → NULL; amend resets; amend to outcome → NULL; supersede new row set; dedup leaves existing value; deprecate leaves value |
| **C — Lifecycle repository + service** | | |
| `src/db/lifecycleRepository.ts` | Modify | `PgLifecycleRepository` (LIST, CONFIRM, RETIRE_ONE, RETIRE_BY_PR, SWEEP) |
| `src/lifecycle/lifecycleService.ts` | Create | `LifecycleService` (mapping, reason policy, `sweep → JobResult`) |
| `tests/lifecycle/fakes.ts` | Create | `FakeLifecycleRepository` (stateful, records calls) |
| `tests/lifecycle/lifecycleService.test.ts` | Create | Mapping; secret reason → `invalid_reason` with no repository call; email reason masked; clamp; sweep aggregation + idempotent second run |
| `tests/db/lifecycle.integration.test.ts` | Create | DB-gated repository suite (see Test Strategy) |
| **D — Read-path per-status exclusion** | | |
| `tests/memory/fakes.ts` | Modify | `FakeMemory.status` += `'pending_revalidation'` (filters already `!== 'active'`) |
| `tests/memory/statusExclusion.test.ts` | Create | Unit: handlers `recall` (BM25 + semantic fallback), `get_memory`, `get_context` over the fakes, one case per status |
| `tests/db/statusExclusion.integration.test.ts` | Create | DB-gated: real `PgMemoryRepository` + `findJudgeContext` per status |
| **E — HTTP routes + audit** | | |
| `src/http/api/memoryRoutes.ts` | Create | `makeMemoryRoutes`, zod schemas, 404/400 mapping, `recordApi` |
| `src/http/api/router.ts` | Modify | Mount `makeMemoryRoutes` on the nested project router |
| `src/auth/auditLogger.ts` | Modify | `WRITE_API_ACTIONS` set |
| `tests/http/api/helpers.ts` | Modify | Inject `FakeLifecycleRepository`-backed service |
| `tests/http/api/memories.test.ts` | Create | Route behaviour (see Test Strategy) |
| `tests/http/api/permissions.test.ts` | Modify | Opacity matrix rows for the 4 new routes |
| `tests/auth/auditLogger.test.ts` | Modify | New write actions → `update`; `memories.list` → `read`; no reason in detail |
| **F — Composition, job, script** | | |
| `src/index.ts` | Modify | `PgPromotionRepository(pool, {revalidationDays})`; `PgLifecycleRepository`; `LifecycleService`; `AppServices.lifecycleService`; jobs map entry `revalidation-sweep` |
| `scripts/jobs/revalidation.ts` | Create | Script per C3 pattern → `sweep()` |
| `package.json` | Modify | `job:revalidation` script |
| `tests/jobs/revalidationJob.test.ts` | Create | Jobs router with the real map entry over a fake service: 200 + `JobResult`; disabled → 404 (C3 behaviour preserved) |
| `scripts/smoke.ts` | Modify | As `tl@demo.local`: `GET …/memories` → 200 `{items, truncated}`; `POST /internal/jobs/revalidation-sweep` (dev) → 200 with `job: 'revalidation-sweep'` |
| **G — Docs** | | |
| `README.md` | Modify | Config row `REVALIDATION_DAYS | 60` |
| `DEVELOPMENT.md` | Modify | Lifecycle curl examples, `pnpm job:revalidation`, how to expire a memory locally (`UPDATE memory SET revalidate_at = now() - interval '1 day'`) |
| `openspec/project-map.yaml` | Modify | Data model: `revalidate_at`, `retired_reason`, new enum values; lifecycle module entry |

## New Modules

None. `src/lifecycle` holds two files.

## Test Strategy

The runner is vitest (`tests/**/*.test.ts`). DB-gated suites use `describeWithDb = DATABASE_URL ? describe : describe.skip` and `runMigrations` in `beforeAll`. HTTP tests use supertest on C2's `makeApiTestApp`. (The loaded `.claude/rules/tests.md` describes node:test, which does not match this repo. This design follows the codebase, as C1 and C2 did.)

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| HU-12.1 expiry → pending (sweep) | integration (`lifecycle.integration`) + unit (service, job) | Active decision with `revalidate_at` in the past → `pending_revalidation`, counted under its project; outcome with a past `revalidate_at` (forced) → untouched; future and NULL → untouched; deprecated with a past value → untouched; two projects → `detail` has both counts; second run → `count 0`; `revalidate_at` and `updated_at` unchanged by the sweep | Force times with direct `UPDATE` |
| HU-12.2 pending excluded from reads | unit (`statusExclusion.test`) + integration (`statusExclusion.integration`) | For each of `superseded`, `deprecated`, `pending_revalidation` alongside one `active` row with matching content: `recall` returns only active and `total_matches` = 1; `recallSemantic` (non-null embeddings) only active; `get_memory` on the non-active handle → opaque `INVALID_REFERENCE` (same error as a random UUID); `get_memory` relations exclude the non-active other side; `get_context` phase1 (constraint) and phase2 (decision) exclude it; `findJudgeContext` excludes it | Distinct `content_hash` per row; handler-level for MCP, repo-level for SQL |
| HU-12.3 confirm | integration + unit (routes) | pending → 200 `{status:'active', revalidateAt≈now+N}`; `current_revision` unchanged, so the old handle resolves again via `get_memory`; `reviewed_at` set; recall finds it again; confirm on active → 404 (D2); repeat confirm → 404; foreign project id → 404; audit `memory.confirm` (`update`) once, none on 404 | |
| HU-12.4 retire | integration + unit | From active → `deprecated`, `retired_reason` stored, `current_revision+1`, revision `op='deprecate'` with the snapshot equal to the pre-retire content, `author_identity = actorId`, `promoted_from_item NULL`, `revalidate_at NULL`; from pending → same; from deprecated or superseded → 404 with no revision; foreign → 404; reason 2 chars / 501 chars / missing / extra key → 400 for an admin, 404 for a non-admin; reason with an AWS key → 400 and nothing stored; reason with an email → stored `[EMAIL]`; concurrent retire ×2 (`Promise.all`, separate clients) → one 200 and one 404, exactly one new revision | Real PG row locks |
| HU-11.4 retire-by-pr | integration + unit | Project P with PR 42: 2 active + 1 pending + 1 deprecated, PR 43: 1 active; other project Q PR 42: 1 active → `{retired: 3}`; one revision each with the correct `revision_no`; PR 43 and Q untouched; repeat → `{retired: 0}` with no new revisions; `originPr` 0 / -1 / `"42"` / 1.5 → 400; audit `{originPr:42, resultCount:3}` | Asserts the `project_id` predicate (proposal risk) |
| Apply `revalidate_at` | integration (`promotion.integration`) | See batch B row; review approve inherits it through `applyOpInTxn` (one C2 approve case asserts it) | |
| List | unit + integration | Default status pending; ordered by `revalidate_at` then id; `limit` → `truncated`; `status=active` → 400 (until C5 widens); unknown query key → 400; only the caller's project | |
| Opacity | unit (`permissions.test`) | contributor, viewer, other-project admin, malformed project uuid, malformed memory uuid → byte-identical 404 on all 4 routes; no audit rows on denial | |
| Audit mapping | unit (`auditLogger.test`) | `memory.confirm/retire/retire_by_pr` → `update`; `memories.list` → `read`; detail never contains `reason` | |
| Migrations | integration (`lifecycle.migrate.integration`) | Enum values exist; re-executing 0009 + 0010 is a no-op; backfill scope; CHECK rejects a 2-char `retired_reason`; both indexes exist (`pg_indexes`) | |
| Config | unit | `REVALIDATION_DAYS` defaults and invalid values (batch A row); ctor guard throws on 0 | |
| Job + script | unit (`revalidationJob.test`) + e2e (smoke) | Router returns `JobResult` from the registered entry; disabled → 404; smoke dev call 200 | C3 router reused |
