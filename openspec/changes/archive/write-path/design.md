# Design: write-path (write-to-staging slice)

schema: design-v1
change: write-path
status: DESIGNED
date: 2026-07-30
depends_on: [proposal.md, exploration.md]

## Technical Approach

Add the three write tools (`remember`, `list_staged`, `discard_staged`) as a
fourth vertical slice that reuses every seam the read path already established:
`ZodRawShape` tool schemas, the SDK destructure-and-reassemble registration
callback, the pure `(input, ctx, deps)` handler, a `pg.Pool`-backed repository
mirroring `MemoryRepository`, the 4-code opaque error model, and the boot-time
`AppServices` injection bag. Writes land ONLY in a lazy-created staging session
keyed `(project, repo, branch)`; nothing touches `memory`. `recall` gains a
staged-item mix (`source:"staged"`) for session continuity.

Two behaviours diverge from the read path on purpose and are called out below:
(1) RBAC now enforces a **role value** per tool (reads only checked membership
existence); (2) the write wrapper audits **after** the handler succeeds (an
audit row must reflect a stage that actually happened, not an attempt that the
secret-scan refused). Promotion to main (`POST /promote`, Bedrock judge,
sanitize, quarantine, the `promoted_at`/`promoted_memory_id` schema gaps) is
explicitly OUT and left for a separate `promotion-pipeline` change.

Grounding: read seams in `src/db/memoryRepository.ts`, `src/mcp/context.ts`,
`src/mcp/tools/{index,schemas,recall}.ts`, `src/auth/{authorizer,auditLogger}.ts`;
authoritative staging DDL in `docs/artefactos/lpms_schema_v2.sql` (l.24-26,
l.171-213); tool contract in `docs/artefactos/lpms_facade_contract_v1.md` §3-§5;
lifecycle in `docs/04-escritura-staging-promocion.md`; per-type fields in
`docs/05-tipos-memoria-y-busqueda.md` and contract §1.

## Architecture Decisions

### Decision 1: `title` / `summary` enforced NOT NULL at migration 0003

**Choice**: Add `NOT NULL` and `char_length` CHECKs on `staging_item.title`
(≤120) and `.summary` (≤200) in migration 0003, on top of zod `.min(1).max(...)`
in the input shape (defense in depth).
**Alternatives considered**: app-layer only (zod/handler); leave nullable as in
schema v2.
**Rationale**: The facade contract (§1/§3) requires both fields; budgets are
already enforced as DB CHECKs on `memory` (0002). The DB is the invariant of
record — a future non-facade writer (promotion apply) cannot bypass it. schema
v2 left them nullable only to accommodate a judge that may fill gaps at
promotion; that actor does not exist in this slice.

### Decision 2: inline pattern-based secret-scan, fail-closed → `PERMISSION_DENIED`

**Choice**: New pure module `src/security/secretScan.ts` (no runtime dep, uses
`node:crypto` only indirectly via existing `sha256Hex`). Broad regex categories:
AWS access-key ids (`AKIA`/`ASIA…`), PEM private-key blocks, JWTs, common
provider tokens (GitHub `gh[pousr]_`, Slack `xox[baprs]-`, Google `AIza…`,
Stripe `sk_live_`/`rk_live_`, OpenAI `sk-…`), and a generic
secret-assignment/high-entropy heuristic. Scanned across
`title+summary+body+JSON.stringify(fields)` **before** any insert. Any finding →
`logger.warn` with **category names only** (never the matched text) →
`throw AppError(PERMISSION_DENIED)`. Any internal error inside the scanner is
caught and also treated as a positive (fail-closed — never persist unscanned
content).
**Alternatives considered**: external secret-scanning service/dep (YAGNI, adds a
runtime dependency the pilot forbids); mapping the refusal to `INVALID_REFERENCE`
or `INTERNAL`.
**Rationale**: Only 4 error codes exist and no 5th may be added.
`INVALID_REFERENCE`'s message ("please recall again") misdirects the agent;
`INTERNAL` mislabels a client-content fault as a server fault and pollutes error
monitoring. `PERMISSION_DENIED` ("Access denied.") is opaque, does not leak that
secret-scanning occurred (no oracle), and correctly frames the outcome as a
policy refusal. Because the scan runs before the insert, a throw guarantees
nothing is persisted.

### Decision 3: session creation via `INSERT … ON CONFLICT DO NOTHING` + re-select

**Choice**: Lazy-create the open session with an upsert that infers the partial
unique index, then re-select on conflict. No advisory lock.
**Alternatives considered**: `pg_advisory_xact_lock` on a hash of the session key.
**Rationale**: The partial unique index `ux_session_open` already guarantees one
`open` session per key at the DB level; the upsert+reselect is lock-free,
stateless (safe with the stateless-per-request transport and a shared pool), and
matches the existing parameterized/idempotent SQL style. Advisory locks add
connection-state and leak risk for no additional guarantee. SQL shape in the
repository section.

### Decision 4: one combined `StagingRepository`

**Choice**: A single `StagingRepository` interface + `PgStagingRepository`
covering session and item queries, mirroring the one-seam-per-path shape of
`MemoryRepository`.
**Alternatives considered**: split `SessionRepository` + `ItemRepository`.
**Rationale**: Session and item operations are always used together in the write
flow; four methods do not justify two injection points (each split repo would
force another `HandlerDeps`/`AppServices`/boot widening). YAGNI.

### Decision 5: per-type `fields` validation in the handler; lenient-shape pilot policy

**Choice**: `fields` is optional and validated in the handler (not zod) by a pure
`assertValidFields(type, fields)` in `src/mcp/fieldsPolicy.ts`. Policy = **strict
on shape, lenient on presence**: every key present must be an allowed key for
that `type`; no key is required; values are not deep-typed. Unknown key →
`AppError(INVALID_REFERENCE)`.
**Alternatives considered**: encode per-type shapes as a zod discriminated union
in the tool schema; require the full per-type field set; accept anything.
**Rationale**: `server.tool()` takes a flat `ZodRawShape`, which cannot express
`type`-dependent cross-field rules — the read path already validates cross-field
concerns (cursor, handle) in handlers, so this is consistent. The contract calls
`fields` "skill-guided" and optional, so requiring them would block valid agents;
accepting arbitrary keys would pollute `fields jsonb`. Allowed-key map (from
contract §1 / docs/05):

| type | allowed `fields` keys |
|------|-----------------------|
| `decision` | `alternatives`, `drivers` |
| `constraint` | `rule`, `scope`, `consequence` |
| `gotcha` | `symptom`, `root_cause`, `fix` |
| `pattern` | `statement`, `applies_to` |
| `integration_note` | `system`, `quirk`, `workaround` |
| `domain_rule` | `rule`, `enforced_in` |
| `outcome` | `about`, `result`, `metrics` |

### Decision 6 (cross-cutting): write wrapper audits AFTER the handler

**Choice**: For `remember` the order is authenticate → resolveTenant → authorize
→ build ctx → **handler (scan + insert)** → **recordWrite**. Reads audit before
the handler; writes audit after success.
**Rationale**: `auditLogger` semantics are "an audit row implies the action
happened." A stage refused by the secret-scan or a dedup no-op must still produce
a truthful trail. Auditing after the successful insert lets `recordWrite` carry
the real `session_id`, `item_id`, and `content_hash`. `list_staged` /
`discard_staged` are own-draft management and are NOT audited in this slice
(no matching `access_action`; low security value) — a conscious scope decision.

### Decision 7 (cross-cutting): stale target handled by flagging `judge_state='uncertain'`, not rejecting

**Choice**: For `amend`/`supersede`/`deprecate`, resolve the target via the
existing `memoryRepository.getMemoryByHandle`. If the decoded revision is stale
(`current_revision > decodedRevision`), still persist the item but set
`judge_state='uncertain'` and store `target_revision = decodedRevision` (the
revision the agent saw). If the target is absent/non-active/cross-project →
`AppError(INVALID_REFERENCE)`.
**Rationale**: Contract §3 mandates that a moved target yields an `uncertain`
item for human review at promotion — not a hard failure at stage time. Reusing
`getMemoryByHandle` avoids a new query and inherits its tenant+active scoping.

## Data Flow

    remember(op,type,title,summary,body,fields?,target_handle?)
        │
        ▼  registerWriteTools callback (src/mcp/tools/index.ts)
    authenticate ─→ resolveTenant ─→ authorize('remember')   [Gate2 + WRITE role]
        │
        ▼  rememberHandler(input, ctx, deps)   (pure)
    assertValidFields(type, fields)                          → INVALID_REFERENCE
    op↔target check + decodeHandle(target_handle)            → INVALID_REFERENCE
    memoryRepository.getMemoryByHandle(target) ─ stale? ─→ judge_state='uncertain'
    assertNoSecrets(title,summary,body,fields)               → PERMISSION_DENIED
    content_hash = sha256Hex(canonical(op,type,…,target))
    stagingRepository.findOrCreateOpenSession(tenant, actorId)
    stagingRepository.insertStagingItem(...)  ── ON CONFLICT → dedup no-op (same id)
        │  returns {id, state, sessionId, contentHash}
        ▼
    auditLogger.recordWrite(ctx, sessionId, id, contentHash)  action:'stage'
        │
        ▼  toToolResult({ id, state })

    recall(...)  first page only:
        stagingRepository.listStagingItems(tenant) ─→ toStagedRecord() source:"staged"
        results = [...stagedRecords, ...mainRecords]   (total_matches = main only)

## Migration 0003 — `migrations/0003_staging.sql`

Numbered format identical to 0001/0002: `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
`DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$` enum guards,
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Fully idempotent.
No `content_tsv` on staging — staging is not full-text searched in this slice
(recall-mix prepends drafts unranked); the `english` FTS constraint applies only
to `memory` (already satisfied in 0002).

Enums to create (guarded). `staging_op` already exists from 0002; re-guarded here
so the file is self-contained:

```sql
DO $$ BEGIN CREATE TYPE staging_status AS ENUM
  ('open','validating','promoted','rejected','abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE judge_state AS ENUM
  ('pending','accepted','uncertain','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE staging_op AS ENUM
  ('add','amend','supersede','deprecate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

`staging_session` (faithful to schema v2 l.171-187; `id` supplied app-side as a
ULID — no DB default):

```sql
CREATE TABLE IF NOT EXISTS staging_session (
    id               text PRIMARY KEY,                         -- ULID (app-generated)
    project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id          uuid NOT NULL REFERENCES repo(id)   ON DELETE CASCADE,
    branch           text NOT NULL,
    status           staging_status NOT NULL DEFAULT 'open',
    opened_by        text NOT NULL,
    pr_number        int,                                      -- unused this slice
    pr_bound_at      timestamptz,                              -- unused this slice
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz,                              -- now()+7d sliding TTL
    created_at       timestamptz NOT NULL DEFAULT now(),
    promoted_at      timestamptz                               -- v2 column; unused
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_open
    ON staging_session(project_id, repo_id, branch) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_session_status ON staging_session(status);
```

`staging_item` (faithful to v2 l.189-213 **plus** Decision 1: `title`/`summary`
NOT NULL + budget CHECKs). Promotion-only columns (`promoted_at`,
`promoted_memory_id`) are intentionally NOT added — OUT of scope:

```sql
CREATE TABLE IF NOT EXISTS staging_item (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       text NOT NULL REFERENCES staging_session(id) ON DELETE CASCADE,
    op               staging_op NOT NULL,
    type             memory_type NOT NULL,
    title            text NOT NULL,                            -- Decision 1
    summary          text NOT NULL,                            -- Decision 1
    body             text NOT NULL,
    fields           jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash     text NOT NULL,
    target_memory_id uuid REFERENCES memory(id) ON DELETE SET NULL,
    target_revision  int,
    judge_state      judge_state NOT NULL DEFAULT 'pending',
    judge_reason     text,
    sanitize_flags   jsonb NOT NULL DEFAULT '{}'::jsonb,
    author_identity  text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_item_optarget CHECK (
        (op =  'add' AND target_memory_id IS NULL)
     OR (op <> 'add' AND target_memory_id IS NOT NULL) ),
    CONSTRAINT ck_item_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_item_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_item_body_len    CHECK (char_length(body)    <= 2000),
    UNIQUE (session_id, content_hash)
);
CREATE INDEX IF NOT EXISTS ix_item_session ON staging_item(session_id);
CREATE INDEX IF NOT EXISTS ix_item_judge   ON staging_item(judge_state);
```

## StagingRepository — `src/db/stagingRepository.ts`

Interface first, then `PgStagingRepository` with `private readonly pool: pg.Pool`,
top-level parameterized SQL constants, `AppError` on bad input, null/empty on
not-found — mirroring `PgMemoryRepository`. All queries tenant-scoped: the item
queries join `staging_session` and filter `project_id=$ AND repo_id=$ AND
branch=$ AND status='open'`, so an item is only ever reachable through the
caller's own open session.

```ts
export interface StagingItemRow {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  content_hash: string;
  target_memory_id: string | null;
  target_revision: number | null;
  judge_state: 'pending' | 'accepted' | 'uncertain' | 'rejected';
  created_at: Date;
}

export interface InsertStagingItemParams {
  op: StagingItemRow['op'];
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  contentHash: string;
  targetMemoryId: string | null;
  targetRevision: number | null;
  judgeState: 'pending' | 'uncertain';   // set by the handler per Decision 7
  authorIdentity: string;
}

export interface StagingRepository {
  /** Lazy upsert of the one open session for the tenant key; bumps 7d TTL. */
  findOrCreateOpenSession(tenant: TenantContext, openedBy: string): Promise<string>;
  /** Idempotent insert; returns the (possibly pre-existing) item id + judge_state. */
  insertStagingItem(sessionId: string, p: InsertStagingItemParams):
    Promise<{ id: string; judgeState: StagingItemRow['judge_state']; deduped: boolean }>;
  /** Caller's own open-session items, newest first; empty if no open session. */
  listStagingItems(tenant: TenantContext): Promise<StagingItemRow[]>;
  /** Deletes one item from the caller's open session; false if not found. */
  discardStagingItem(tenant: TenantContext, itemId: string): Promise<boolean>;
}
```

**`findOrCreateOpenSession`** (Decision 3, ULID from `src/db/ulid.ts`):

```sql
-- 1) attempt create (id = ulid() bound param $1)
INSERT INTO staging_session
  (id, project_id, repo_id, branch, status, opened_by, last_activity_at, expires_at)
VALUES ($1, $2, $3, $4, 'open', $5, now(), now() + interval '7 days')
ON CONFLICT (project_id, repo_id, branch) WHERE status = 'open' DO NOTHING
RETURNING id;
-- 2) if no row returned (conflict), re-select the existing open session:
SELECT id FROM staging_session
WHERE project_id = $1 AND repo_id = $2 AND branch = $3 AND status = 'open';
-- 3) sliding TTL bump (both paths):
UPDATE staging_session
SET last_activity_at = now(), expires_at = now() + interval '7 days'
WHERE id = $1;
```

**`insertStagingItem`** (idempotent dedup):

```sql
INSERT INTO staging_item
  (session_id, op, type, title, summary, body, fields, content_hash,
   target_memory_id, target_revision, judge_state, author_identity)
VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
ON CONFLICT (session_id, content_hash) DO NOTHING
RETURNING id, judge_state;
-- if no row returned → dedup no-op; re-select existing:
SELECT id, judge_state FROM staging_item
WHERE session_id = $1 AND content_hash = $8;
```
Returns `{ deduped: true }` on the re-select path so the handler can treat it as
an idempotent no-op (same `{id, state}` returned — indistinguishable to caller).

**`listStagingItems`** (reused by `list_staged` and recall-mix):

```sql
SELECT i.id, i.op, i.type, i.title, i.summary, i.body, i.fields,
       i.content_hash, i.target_memory_id, i.target_revision,
       i.judge_state, i.created_at
FROM staging_item i
JOIN staging_session s ON s.id = i.session_id
WHERE s.project_id = $1 AND s.repo_id = $2 AND s.branch = $3 AND s.status = 'open'
ORDER BY i.created_at DESC;
```

**`discardStagingItem`** (tenant-scoped delete; opaque when absent):

```sql
DELETE FROM staging_item i
USING staging_session s
WHERE i.id = $1 AND i.session_id = s.id
  AND s.project_id = $2 AND s.repo_id = $3 AND s.branch = $4 AND s.status = 'open';
```
`rowCount > 0` → true; 0 → handler maps to `AppError(INVALID_REFERENCE)`.

**`src/db/ulid.ts`** — tiny inline `ulid(): string` (no dep): 48-bit
`Date.now()` + 80 bits from `crypto.randomBytes(10)`, Crockford base32
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 26 chars. Honors the documented "ULID for
time-sortable staging_session" convention without a runtime dependency.

## Tool contracts

### schemas (`src/mcp/tools/schemas.ts`)

Add `STAGING_OPS = ['add','amend','supersede','deprecate'] as const` and three
`ZodRawShape` exports (budgets mirror the DB CHECKs; `fields` shape validated in
the handler per Decision 5):

```ts
export const rememberInputShape = {
  op: z.enum(STAGING_OPS).describe('Suggested operation; the judge may reclassify at promotion'),
  type: z.enum(MEMORY_TYPES).describe('Memory type (contract §1)'),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  fields: z.record(z.unknown()).optional().describe('Per-type fields (skill-guided)'),
  target_handle: z.string().optional().describe('Required for amend/supersede/deprecate'),
};
export const listStagedInputShape = {};
export const discardStagedInputShape = {
  item_id: z.string().describe('Id of a staging item in the caller’s own session'),
};
```

### contracts (`src/contracts/tools.ts`)

```ts
export interface RememberRequest {
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string; summary: string; body: string;
  fields?: Record<string, unknown>;
  target_handle?: string;
}
export interface RememberResponse { id: string; state: 'pending' | 'uncertain'; }
// internal handler return (superset; wrapper projects to RememberResponse for the agent)
export interface RememberResult extends RememberResponse { sessionId: string; contentHash: string; }

export interface StagedItemView {
  id: string; op: RememberRequest['op']; type: MemoryType;
  title: string; summary: string; state: string; date: string;
}
export interface ListStagedResponse { items: StagedItemView[]; }

export interface DiscardStagedRequest { item_id: string; }
export interface DiscardStagedResponse { discarded: true; }
```

### `rememberHandler(input, ctx, deps): Promise<RememberResult>`

1. `assertValidFields(input.type, input.fields ?? {})` → `INVALID_REFERENCE` on
   unknown key (Decision 5).
2. **op↔target**: if `op==='add'` and `target_handle` present →
   `INVALID_REFERENCE`; if `op!=='add'` and `target_handle` absent →
   `INVALID_REFERENCE`.
3. Resolve target (non-`add` only): `decodeHandle(target_handle)` (throws
   `INVALID_REFERENCE`); `target = await deps.memoryRepository.getMemoryByHandle(
   ctx.tenant, decoded.memoryId)`; if `null` → `INVALID_REFERENCE`;
   `stale = isHandleStale(target.memory.current_revision, decoded.revisionNo)`;
   `judgeState = stale ? 'uncertain' : 'pending'`;
   `targetMemoryId = decoded.memoryId`; `targetRevision = decoded.revisionNo`.
   For `add`: `judgeState='pending'`, target fields `null` (Decision 7).
4. **secret-scan**: `assertNoSecrets(input.title, input.summary, input.body,
   JSON.stringify(input.fields ?? {}))` → `PERMISSION_DENIED` on any finding
   (Decision 2). Runs BEFORE any DB write.
5. `contentHash = sha256Hex(canonical)` where `canonical =
   JSON.stringify({op,type,title,summary,body,fields:input.fields ?? {},
   target: targetMemoryId})` (fixed key order; `op` included so add vs amend of
   identical text differ).
6. `sessionId = await deps.stagingRepository.findOrCreateOpenSession(ctx.tenant,
   ctx.actor.actorId)`.
7. `res = await deps.stagingRepository.insertStagingItem(sessionId, { …,
   contentHash, targetMemoryId, targetRevision, judgeState,
   authorIdentity: ctx.actor.actorId })`. Dedup path returns the existing
   `{id, judgeState}` unchanged (idempotent no-op).
8. `return { id: res.id, state: res.judgeState as 'pending'|'uncertain',
   sessionId, contentHash }`.

Wrapper projects `{ id, state }` to the agent and calls
`deps.auditLogger.recordWrite(ctx, sessionId, id, contentHash)` (Decision 6).

### `listStagedHandler(_input, ctx, deps): Promise<ListStagedResponse>`

`items = (await deps.stagingRepository.listStagingItems(ctx.tenant)).map(toStagedItemView)`
where `toStagedItemView` projects `{id, op, type, title, summary,
state: row.judge_state, date: row.created_at.toISOString()}`. Empty session →
`{ items: [] }`.

### `discardStagedHandler(input, ctx, deps): Promise<DiscardStagedResponse>`

`ok = await deps.stagingRepository.discardStagingItem(ctx.tenant, input.item_id)`;
if `!ok` → `AppError(INVALID_REFERENCE)` (opaque; does not reveal whether the
item exists in another session). Else `{ discarded: true }`.

### registration (`src/mcp/tools/index.ts`)

Add `registerWriteTools(server: McpServer, deps: Deps): void` alongside
`registerReadTools`, following the SDK destructure-and-reassemble rule (never
forward raw args — the historical cursor bug). Each callback: `try { …
authenticate → resolveTenant → authorize('<tool>') → build ctx → handler →
(remember only) recordWrite → asCTR(toToolResult(projected)) } catch (err) {
if not AppError logger.error; return asCTR(toToolErrorResult(err)); }`.
`server.ts createMcpServer` gains one line: `registerWriteTools(server, deps);`.

## recall staging-mix (`src/mcp/tools/recall.ts`)

Deliberately minimal for the pilot: staged drafts are surfaced for **continuity**
(after a compaction), not ranked as authority.

1. Compute main results exactly as today via `deps.memoryRepository.recall(...)`.
2. **First page only** (`input.cursor` is null/undefined):
   `staged = await deps.stagingRepository.listStagingItems(ctx.tenant)` →
   `stagedRecords = staged.map(item => toStagedRecord(item, ctx.tenant.branch))`.
   On cursor pages, skip the staged fetch entirely (keeps keyset pagination over
   `memory` pristine).
3. `results = [...stagedRecords, ...mainRecords]` — staged prepended, newest
   first (already ordered by `listStagingItems`).
4. `total_matches = main total` (staged are additive drafts, not counted);
   `cursor = main nextCursor` unchanged.

No FTS filtering of staged items in this slice (an open session's item set is
small and bounded by the 7d TTL; filtering deferred). `toStagedRecord` (new, in
`memoryMapper.ts`, sibling to `toMemoryRecord`): `handle =
encodeHandle(item.id, 1)`, `date = item.created_at.toISOString()`, `origin =
{ branch: tenant.branch, pr: null }`, `source: 'staged'`. A `get_memory` on a
staged handle naturally returns `INVALID_REFERENCE` (not in `memory`) — correct:
drafts are not authoritative lookups.

## RBAC change (`src/auth/authorizer.ts` + `src/mcp/context.ts`)

**ToolName widening** (context.ts l.59):
```ts
export type ToolName =
  | 'recall' | 'get_memory' | 'get_context'
  | 'remember' | 'list_staged' | 'discard_staged';
```

**Role-map enforcement** in `RdsAuthorizer.authorize` (uses the already-fetched
`membershipRole`; add before the return):
```ts
const WRITE_TOOLS: ReadonlySet<ToolName> =
  new Set(['remember','list_staged','discard_staged']);
const WRITE_ROLES: ReadonlySet<string> =
  new Set(['project_admin','contributor','service_agent']);
// …after membershipRole is resolved:
if (WRITE_TOOLS.has(tool) && !WRITE_ROLES.has(membershipRole)) {
  throw new AppError(ErrorCode.PERMISSION_DENIED);   // viewer denied, opaque
}
```
Reads keep the existing membership-existence check only. The check is on the
**project membership role** (contract §4: `contributor`/`service_agent`;
`project_admin` is a superset writer). Platform global roles do NOT grant write
without a writer membership row — consistent with the read-path D4 rule that
project access flows from membership.

**Why atomic**: the current authorizer ignores `_tool` and gates only on
membership existence. If `ToolName` were widened and the write tools registered
WITHOUT the role check landing in the same change, any viewer with a membership
row would pass the write gate — an authorization hole. Widening, registration,
and role enforcement therefore ship together in one change/commit.

## AuditLogger.recordWrite

Interface addition (context.ts, the `AuditLogger` seam):
```ts
recordWrite(ctx: RequestContext, sessionId: string, itemId: string,
            contentHash: string): Promise<void>;
```
`RdsAuditLogger` implementation (no `AuthRepository` change needed —
`AccessLogEntry` already supports `action:'stage'`, `sessionId`, and `actorKind`):
```ts
await this.repo.insertAccessLog({
  actorIdentity: ctx.actor.actorId,
  actorKind: 'user',
  action: 'stage',
  projectId: ctx.tenant.projectId,
  sessionId,
  queryHash: contentHash,                 // a hash already; no raw text
  detail: { tool: 'remember', repoId: ctx.tenant.repoId,
            branch: ctx.tenant.branch, itemId },
});
```
Resulting `access_log` row: `action='stage'`, `actor_kind='user'`,
`project_id=<tenant>`, `session_id=<ULID>`, `query_hash=<content_hash>`,
`detail={tool,repoId,branch,itemId}`, `memory_id=NULL`.

## Injection widening — `src/mcp/context.ts` (the 4 edit points)

| Point | Line (current) | Change |
|-------|----------------|--------|
| import | top | `import type { StagingRepository } from '../db/stagingRepository.js';` |
| `ToolName` | l.59 | add `\| 'remember' \| 'list_staged' \| 'discard_staged'` |
| `AuditLogger` | l.107-109 | add `recordWrite(ctx, sessionId, itemId, contentHash): Promise<void>` |
| `HandlerDeps` | l.119 | add `stagingRepository: StagingRepository;` |
| `AppServices` | l.140 | add `stagingRepository: StagingRepository;` |

`Deps` (l.149) `extends HandlerDeps, AuthServices` → inherits `stagingRepository`
automatically. `transport.ts:51` spreads `services` → picks it up with no change.
`src/index.ts` composition root: add
`const stagingRepository = new PgStagingRepository(pool);` and include
`stagingRepository` in the `services: AppServices` object.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `migrations/0003_staging.sql` | Create | staging_status + judge_state enums (guarded); `staging_session` + `ux_session_open` + `ix_session_status`; `staging_item` with NOT NULL title/summary, op↔target/budget CHECKs, `UNIQUE(session_id,content_hash)`, indexes. Idempotent. |
| `src/db/stagingRepository.ts` | Create | `StagingRepository` interface + `PgStagingRepository` (4 methods, parameterized, tenant-scoped SQL constants). |
| `src/db/ulid.ts` | Create | Inline `ulid()` (Crockford base32, `node:crypto`; no dep). |
| `src/security/secretScan.ts` | Create | `scanForSecrets` + `assertNoSecrets` (fail-closed → `PERMISSION_DENIED`; category-only logging). |
| `src/mcp/fieldsPolicy.ts` | Create | Per-type allowed-key map + `assertValidFields(type, fields)` (→ `INVALID_REFERENCE`). |
| `src/mcp/tools/remember.ts` | Create | `rememberHandler` (8-step algorithm). |
| `src/mcp/tools/listStaged.ts` | Create | `listStagedHandler`. |
| `src/mcp/tools/discardStaged.ts` | Create | `discardStagedHandler`. |
| `src/mcp/tools/schemas.ts` | Modify | Add `STAGING_OPS` + 3 write input shapes. |
| `src/mcp/tools/index.ts` | Modify | Add `registerWriteTools(server, deps)` (audit-after for remember). |
| `src/mcp/tools/recall.ts` | Modify | First-page staged-item mix (`source:"staged"`). |
| `src/mcp/memoryMapper.ts` | Modify | Add `toStagedRecord(item, branch)`; `toMemoryRecord` unchanged. |
| `src/mcp/context.ts` | Modify | 4 widening points + `AuditLogger.recordWrite` + import. |
| `src/mcp/server.ts` | Modify | Call `registerWriteTools(server, deps)`. |
| `src/auth/authorizer.ts` | Modify | Enforce `WRITE_TOOLS`→`WRITE_ROLES` (atomic with widening). |
| `src/auth/auditLogger.ts` | Modify | Implement `recordWrite` (`action:'stage'`). |
| `src/contracts/tools.ts` | Modify | Add Remember/ListStaged/DiscardStaged request+response + `RememberResult`/`StagedItemView`. |
| `src/index.ts` | Modify | Instantiate `PgStagingRepository`; add to `services`. |
| `tests/staging/fakes.ts` | Create | `InMemoryStagingRepository` (mirrors `tests/memory/fakes.ts`). |
| `tests/staging/remember.test.ts` | Create | Handler unit tests (see plan). |
| `tests/staging/listStaged.test.ts` | Create | Handler unit tests. |
| `tests/staging/discardStaged.test.ts` | Create | Handler unit tests. |
| `tests/staging/recallMix.test.ts` | Create | recall staged-mix unit tests. |
| `tests/security/secretScan.test.ts` | Create | Pattern + fail-closed tests. |
| `tests/mcp/fieldsPolicy.test.ts` | Create | Allowed/unknown-key tests. |
| `tests/db/ulid.test.ts` | Create | Format/uniqueness tests. |
| `tests/db/staging.migrate.integration.test.ts` | Create | DB-gated: schema + CHECK/constraint enforcement. |
| `tests/db/stagingRepository.integration.test.ts` | Create | DB-gated: upsert race, dedup, scoping. |
| `tests/mcp/registration.test.ts` | Modify | Expect SIX tools; assert `remember`/`discard_staged` schemas. |
| `tests/auth/authorizer.test.ts` | Modify | Write-role matrix (viewer denied, contributor/service_agent/project_admin allowed). |
| `tests/auth/auditLogger.test.ts` | Modify | `recordWrite` row shape (`action:'stage'`, session_id, query_hash). |
| `tests/mcp/recall.test.ts`, `tests/memory/recall.test.ts` | Modify | Provide (empty) staging dep so existing assertions hold. |

## Test Plan

Mirrors existing patterns: SDK `InMemoryTransport + Client → listTools()` for
registration; direct handler calls with an `InMemoryStagingRepository` fake for
handlers; DB-gated `pg` integration for migration + repository (same gating as
`tests/db/*.integration.test.ts`).

- **Registration** (`tests/mcp/registration.test.ts`): update `EXPECTED_TOOL_NAMES`
  to six; assert `remember` exposes `op/type/title/summary/body`, `discard_staged`
  exposes `item_id`. Guards against a handler that exists but is never wired.
- **remember handler**: add → `{id, state:'pending'}`; amend with fresh handle →
  `pending`, target/rev set; amend with stale handle → `uncertain`; amend with
  unknown/cross-project target → `INVALID_REFERENCE`; `add` + `target_handle` and
  `amend` without `target_handle` → `INVALID_REFERENCE`; duplicate content →
  same id, no second insert (dedup); unknown `fields` key → `INVALID_REFERENCE`;
  AWS key / private-key block / JWT in body → `PERMISSION_DENIED` and nothing
  persisted.
- **list_staged / discard_staged handlers**: list returns own-session items
  (empty when no session); discard own item → `{discarded:true}`; unknown or
  other-session item → `INVALID_REFERENCE`.
- **recall mix**: first page prepends staged records with `source:"staged"` and
  `total_matches` counts main only; a cursor (non-first) page returns no staged
  items; no open session → identical to today.
- **authorizer**: viewer + any write tool → `PERMISSION_DENIED`; contributor /
  service_agent / project_admin + write tool → `ActorIdentity`; all roles + read
  tools unchanged.
- **auditLogger**: `recordWrite` inserts `action:'stage'`, `actor_kind:'user'`,
  `session_id` set, `query_hash === contentHash`, `detail` carries
  `tool/repoId/branch/itemId`.
- **secretScan** unit: positive for each category; clean prose → no findings;
  `assertNoSecrets` throws `PERMISSION_DENIED` and logs categories only.
- **fieldsPolicy** unit: allowed subset passes; empty `{}` passes; unknown key
  throws `INVALID_REFERENCE`.
- **ulid** unit: 26-char Crockford alphabet, uniqueness across a batch,
  monotonic-ish by construction (timestamp prefix).
- **migration integration** (DB-gated): apply 0001-0003; assert tables/enums/
  indexes exist; inserting `op='add'` with a target, `op='amend'` without a
  target, NULL title/summary, over-budget title/summary/body, a second `open`
  session for the same key, and a duplicate `(session_id, content_hash)` are all
  rejected.
- **repository integration** (DB-gated): two `findOrCreateOpenSession` calls for
  the same key return the same id (upsert+reselect race); `insertStagingItem`
  twice with the same hash → one row, `deduped:true` on the second;
  `listStagingItems` returns only the caller-key session's items;
  `discardStagingItem` deletes only within the caller's open session and returns
  false otherwise.

Run gate: `npm run build && npm test -- --run && npm run lint` (pnpm-only for
installs: `pnpm install --frozen-lockfile`).
