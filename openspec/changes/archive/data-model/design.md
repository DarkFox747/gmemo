# Design — Data Model (Change B): wire read tools to real memory data

schema: design-v1
change: data-model
author: crombie-architect
depends_on: auth-two-gate (archived), scaffold-runtime-mcp-facade (archived)
implements: openspec/changes/data-model/proposal.md (D1–D8)

## Technical Approach

Land the three READ-core tables (`memory`, `memory_revision`, `memory_relation`) in
`migrations/0002_memory.sql`, mirroring 0001's idempotency style and schema v2 exactly —
with the single, deliberate deviation of the FTS dictionary (`english`, not `simple`).
Introduce a `MemoryRepository` seam (interface + `PgMemoryRepository`) that mirrors the
existing `AuthRepository` pattern one-for-one: parameterized SQL only, a pg-backed
production impl, an in-memory fake for tests. Add a server-only `handle` codec
(`src/mcp/handle.ts`). Replace the three stub handler bodies with repository calls and a
shared row→contract mapper. Widen the services bag to `AppServices` and thread it through
transport/app/index — in a strict edit order so the build never breaks. Every query is
scoped to the already-resolved `ctx.tenant`; the client never supplies a tenant, memory id,
revision, or cursor value that reaches SQL unvalidated.

This is a read-only slice. Staging tables, the `remember`/promotion write path, pgvector,
and Layer-2 graph tools are all out of scope (D1); `recall` therefore returns `source:"main"`
exclusively and the contract §5 staging-mix is deferred with the staging tables.

---

## Architecture Decisions

### Decision: Migrate only the READ core; defer staging (D1)

**Choice**: `0002_memory.sql` creates `memory`, `memory_revision`, `memory_relation` and the
enums/indexes they need. `staging_session`/`staging_item` are NOT created.
**Alternatives considered**: Migrate all Layer-1 + staging tables now (schema v2 has them).
**Rationale**: Staging tables are inert without the write path, which still has known schema
gaps (`promoted_at`, `partially_promoted`, quarantine — see project-map `known_gaps_for_prod`).
Creating them now is premature coupling with zero read-path benefit. `recall` returning
`source:"main"` only is valid for a read-only pilot. Note: `memory_revision.op` is typed
`staging_op`, so the `staging_op` enum IS created in 0002 even though the staging tables are not.

### Decision: FTS dictionary = `english` (D2) — the ONLY deviation from schema v2

**Choice**: Both the generated `content_tsv` column and every `websearch_to_tsquery(...)` in
`recall` use `'english'`. All other DDL (columns, CHECKs, FKs, defaults, weights A/B/C, index
names) is byte-faithful to `docs/artefactos/lpms_schema_v2.sql`.
**Alternatives considered**: Keep `'simple'` (schema v2 as-written).
**Rationale**: All memory content is English (skill-enforced convention). `english` adds
stemming/stop-words → materially better recall. Critically, the dictionary is baked into a
`GENERATED ALWAYS ... STORED` column: changing it after any data is written requires
rebuilding every tsvector. It MUST be decided before first write — this change is that
gate. Resolves the pilot-blocking open decision.

### Decision: Handle = base64url("<memory_id>:<revision_no>"), server-only (D3)

**Choice**: One codec in `src/mcp/handle.ts`. No DB column. A handle is valid to serve iff the
memory still exists, is `active`, in the caller's project, AND `current_revision` equals the
decoded `revision_no`. Any deviation → one opaque reference error.
**Alternatives considered**: Signed/HMAC handle (integrity); opaque random token with a
server-side lookup table.
**Rationale**: The handle is not a security token — every request is independently
re-authorized and tenant-scoped, so tampering cannot escape the tenant. A stateless encode of
(id, revision) is the minimum that satisfies "opaque, per-recall, bound to (memory_id,
revision)" (contract §1) with zero storage. HMAC/lookup-table add machinery YAGNI does not
justify at pilot.

### Decision: recall rank = ts_rank_cd / (1 + age_days/30) over `updated_at` (D4)

**Choice**: `ts_rank_cd(content_tsv, q) / (1 + (age_seconds/86400)/30)`, `age` from `updated_at`
(30-day half-life). pgvector deferred.
**Alternatives considered**: `created_at` decay (ignores amends); `reviewed_at` (nullable);
BM25/pgvector RRF (needs pgvector).
**Rationale**: `updated_at` reflects the last promotion/amend, so a re-promoted record ranks
fresh — the intuitively correct recency signal. `reviewed_at` is nullable → unusable as the
sole signal. pgvector is explicitly deferred; responses/docs note semantic recall is inactive.

### Decision: keyset cursor over (rank, id), fetch limit+1 (D5)

**Choice**: Order `rank DESC, id DESC`; keyset predicate
`(rank < :r) OR (rank = :r AND id < :id)`; fetch `limit+1` to detect the next page;
`total_matches` from a separate `COUNT(*)` over the same predicate WITHOUT the keyset/limit.
Cursor is an opaque base64url string, encoded/decoded inside the repository.
**Alternatives considered**: `OFFSET` pagination; `COUNT(*) OVER()` window in the page query.
**Rationale**: OFFSET is fragile under live inserts (skips/dupes). A window count would only
count post-cursor rows, so `total_matches` must be a separate query. Keyset is stable and
index-friendly. The rank alias cannot be referenced in `WHERE`, so the query wraps the ranked
set in a CTE and filters on the alias there.

### Decision: recall gains an optional `cursor` param

**Choice**: Extend `recallInputShape`/`RecallRequest` with `cursor?: string`. The returned
cursor is only useful if the client can send it back.
**Alternatives considered**: Return a cursor the client cannot consume (dead field).
**Rationale**: Contract §2/§8 prose explicitly promises "un cursor para pedir la siguiente
tanda". The v1 param table omitted it, but pagination (D5) is in scope, so this is a necessary
clarification of the contract, not a new feature. The MCP tool schema stays additive and
backward-compatible (optional).

### Decision: get_context ordering + budget (D6)

**Choice**: Two queries. Phase 1 — `type IN ('constraint','domain_rule') AND status='active'`,
project-scoped, returned WHOLE (never budget-dropped). Phase 2 — `type IN ('decision','gotcha')
AND status='active' ORDER BY updated_at DESC`, project-scoped, capped to a candidate limit. The
handler concatenates `[...phase1, ...phase2]` and trims phase-2 by a ~2500-token budget between
whole records. `stale` (TTL-expired-but-active) computed in SQL for both phases.
**Alternatives considered**: Fixed time window for "recent"; repo-first scoping/boost; DB-side
budget cut.
**Rationale**: A fixed window drops relevant older decisions and floods on busy repos; top-N by
recency self-tunes. Constraints/domain_rules are project-wide governance → project scope
(matches recall's default `project` scope); repo-first boosting is deferred (YAGNI). The budget
is a presentation concern the contract owns at the app layer; whole-record CHECK limits
(body ≤ 2000) guarantee no record is ever half-cut.

### Decision: `AppServices = AuthServices & { memoryRepository }` (D7)

**Choice**: A new `AppServices` interface (NOT overloading `AuthServices`). Widen
`makeMcpPostHandler`/`createApp` to `AppServices` BEFORE adding `memoryRepository` to
`HandlerDeps` (edit order below).
**Alternatives considered**: Add `memoryRepository` directly to `AuthServices`.
**Rationale**: Overloading `AuthServices` conflates the auth seam with the data seam and forces
every auth-only consumer to know about the repo. A distinct combined type keeps the boundary
clean and makes the widening a single, greppable change.

### Decision: composite `(project_id,status,type)` + partial `WHERE ttl_days IS NOT NULL` (D8)

**Choice**: Add `ix_memory_proj_status_type(project_id,status,type)` and
`ix_memory_ttl(project_id,ttl_days) WHERE ttl_days IS NOT NULL`, on top of schema v2's indexes.
**Alternatives considered**: Rely on v2's `ix_memory_proj_status` + `ix_memory_proj_type` alone.
**Rationale**: get_context phase 1/2 and recall all filter `project_id + status (+ type)`; the
composite serves that access path in one index. Its `(project_id,status)` prefix overlaps
v2's `ix_memory_proj_status` — both are kept for faithful mirroring; the redundant one may be
dropped later (documented, accepted minor write cost). The partial TTL index is a cheap
forward aid for stale sweeps (marginal at pilot scale).

### Decision: get_memory does NOT return revision history; stale/invalid handle → opaque error

**Choice**: `GetMemoryResponse` (per `src/contracts/tools.ts`) has no revision-history field, so
`getMemoryByHandle` does NOT query `memory_revision`. Stale is decided from `memory.current_revision`
alone. If the memory is missing / non-active / cross-project, OR `current_revision != decoded
revision_no`, the handler throws ONE opaque reference error (contract §6 "handle inválido o vencido").
**Alternatives considered**: Return the current record flagged `stale:true` (exploration framed
stale as informational); fetch + return the revision list.
**Rationale**: Contract §6 mandates a stale/expired handle become a reference ERROR so the agent
re-`recall`s — not silently-served drifted content. `MemoryRecord.stale` is reserved for
get_context's TTL semantics (a different meaning). Querying a revision list the response cannot
carry is dead work (YAGNI) — add it only if a future contract exposes history.

### Decision: `references` = distinct target handles derived from `relations`

**Choice**: `GetMemoryResponse.references` = de-duplicated opaque handles from the `relations`
edges (no separate query, no body-text parsing).
**Alternatives considered**: Return `[]`; parse handles out of body text.
**Rationale**: The only "references this record points to" that exist in the data model are the
typed relation edges. Deriving the flat handle list is free and gives the agent a
type-agnostic "what to `get_memory` next" list. Body-text reference extraction has no parser and
no table → deferred.

---

## Data Flow

    MCP tool call (recall/get_memory/get_context)
        │
        ▼
    registerReadTools wrapper (unchanged):
      authenticate → resolveTenant → authorize → RequestContext → audit
        │  ctx.tenant {projectId, repoId, branch}, ctx.actor
        ▼
    handler(input, ctx, deps)                    deps.memoryRepository (NEW)
        │                                              │
        │  recall:   {query,scope,types,limit,cursor}  │ parameterized SQL, project-scoped
        │  get_mem:  decodeHandle(input.handle) ───────┤ (handle.ts)
        │  get_ctx:  ()                                 │
        ▼                                              ▼
    memoryMapper.toMemoryRecord(row, {stale})    PgMemoryRepository ──▶ Postgres (memory*)
        │  handle = encodeHandle(id,current_revision)
        │  source = 'main'  (D1)
        ▼
    RecallResponse / GetMemoryResponse / GetContextResponse  (src/contracts/*)
        │
        ▼
    toToolResult(...)  (opaque errors on any throw — unchanged)

Boot wiring (composition root):

    src/index.ts
      createPool → new PgMemoryRepository(pool)
        └─▶ AppServices { ...auth seams, memoryRepository }
              └─▶ createApp(services) ─▶ makeMcpPostHandler(services)
                    └─▶ Deps = { ...services, resolutionInput }  (memoryRepository flows in via spread)

---

## 1. Migration `0002_memory.sql`

Idempotency mirrors 0001: `CREATE EXTENSION IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN
duplicate_object THEN NULL; END $$` per enum, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF
NOT EXISTS`. Runs after 0001 by lexical order via `src/db/migrate.ts` (BEGIN/COMMIT per file,
`schema_migrations` ledger, version = `0002_memory`).

**Faithfulness callout**: identical to schema v2 §MEMORIA AUTORITATIVA EXCEPT the three
`to_tsvector('simple', ...)` calls in `content_tsv` are changed to `to_tsvector('english', ...)`
(D2). Every other column, CHECK, FK, default, weight, and index name is unchanged.

```sql
-- Migration 0002: memory READ core (memory + memory_revision + memory_relation).
-- Faithful subset of docs/artefactos/lpms_schema_v2.sql — the enums used by the
-- three read tables and the tables/indexes themselves. Staging tables are NOT
-- created (change B is read-only; see design D1).
-- ONLY deviation from schema v2: content_tsv uses the 'english' dictionary
-- instead of 'simple' (design D2) — decided before any data is written.
-- Idempotent: safe to apply more than once (guards on all DDL).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ------------------------------------------------------------------
-- ENUMS (idempotent: exception-swallowed if type already exists)
-- ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM
    ('decision','constraint','gotcha','pattern','integration_note','domain_rule','outcome');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE memory_status AS ENUM ('active','superseded','deprecated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE provenance AS ENUM ('pr_reviewed','manual_ui');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- memory_revision.op is typed staging_op; the enum is required here even though
-- the staging tables are deferred (design D1).
DO $$ BEGIN
  CREATE TYPE staging_op AS ENUM ('add','amend','supersede','deprecate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE relation_type AS ENUM ('supersedes','conflicts_with','duplicate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE relation_src AS ENUM ('judge','human');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------------
-- MEMORY (authoritative, structured, versioned)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    repo_id       uuid REFERENCES repo(id) ON DELETE SET NULL,
    type          memory_type NOT NULL,
    title         text NOT NULL,                 -- <= 120 chars (CHECK below)
    summary       text NOT NULL,                 -- <= 200 chars
    body          text NOT NULL,                 -- <= 2000 chars (markdown)
    fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- D2: 'english' dictionary (schema v2 used 'simple') — weights A/B/C.
    content_tsv   tsvector GENERATED ALWAYS AS
                    (setweight(to_tsvector('english', coalesce(title,'')),'A') ||
                     setweight(to_tsvector('english', coalesce(summary,'')),'B') ||
                     setweight(to_tsvector('english', coalesce(body,'')),'C')) STORED,
    status        memory_status NOT NULL DEFAULT 'active',
    provenance    provenance NOT NULL,
    author_identity text NOT NULL,
    content_hash  text NOT NULL,
    current_revision int NOT NULL DEFAULT 1,
    origin_branch text,
    origin_pr     int,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    reviewed_at   timestamptz,
    ttl_days      int,
    UNIQUE (project_id, content_hash),
    CONSTRAINT ck_memory_title_len   CHECK (char_length(title)   <= 120),
    CONSTRAINT ck_memory_summary_len CHECK (char_length(summary) <= 200),
    CONSTRAINT ck_memory_body_len    CHECK (char_length(body)    <= 2000)
);

-- Schema v2 indexes (faithful)
CREATE INDEX IF NOT EXISTS ix_memory_tsv         ON memory USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS ix_memory_fields      ON memory USING gin (fields);
CREATE INDEX IF NOT EXISTS ix_memory_proj_status ON memory(project_id, status);
CREATE INDEX IF NOT EXISTS ix_memory_proj_type   ON memory(project_id, type);
CREATE INDEX IF NOT EXISTS ix_memory_repo        ON memory(repo_id);
-- D8 additions
CREATE INDEX IF NOT EXISTS ix_memory_proj_status_type ON memory(project_id, status, type);
CREATE INDEX IF NOT EXISTS ix_memory_ttl ON memory(project_id, ttl_days) WHERE ttl_days IS NOT NULL;

-- ------------------------------------------------------------------
-- MEMORY_REVISION (immutable audit trail)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_revision (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    revision_no   int NOT NULL,
    op            staging_op NOT NULL,
    title         text NOT NULL,
    summary       text NOT NULL,
    body          text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
    type          memory_type NOT NULL,
    content_hash  text NOT NULL,
    author_identity text NOT NULL,
    promoted_from_item uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (memory_id, revision_no)
);
CREATE INDEX IF NOT EXISTS ix_revision_memory ON memory_revision(memory_id);

-- ------------------------------------------------------------------
-- MEMORY_RELATION (typed edges)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_relation (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_memory   uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    to_memory     uuid NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    relation_type relation_type NOT NULL,
    confidence    real,
    source        relation_src NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (from_memory <> to_memory),
    UNIQUE (from_memory, to_memory, relation_type)
);
CREATE INDEX IF NOT EXISTS ix_relation_from ON memory_relation(from_memory);
CREATE INDEX IF NOT EXISTS ix_relation_to   ON memory_relation(to_memory);
```

---

## 2. `MemoryRepository` interface + `PgMemoryRepository`

Mirrors `src/db/authRepository.ts`: interface + supporting types + a single pg-backed impl
constructed with `new PgMemoryRepository(pool)`. All SQL parameterized. Cursor codec is
private to this module and re-exported for the fake.

### Supporting types

```ts
import pg from 'pg';
import type { MemoryType } from '../contracts/memory.js';
import type { TenantContext } from '../mcp/context.js';

/** Internal projection of a memory row used to build MemoryRecord. */
export interface MemoryRow {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
  origin_branch: string | null;
  origin_pr: number | null;
  current_revision: number;
  updated_at: Date;
  /** Only populated by getContextRecords; TTL-expired-but-active. */
  stale?: boolean;
}

export interface RecallParams {
  query: string;
  scope: 'repo' | 'project';
  types?: MemoryType[];
  limit: number;            // caller-normalized (default 8, max 50)
  cursor?: string | null;   // opaque; decoded inside the repo
}

export interface RecallResult {
  rows: MemoryRow[];
  totalMatches: number;
  nextCursor: string | null;
}

export interface RelationRow {
  relation_type: 'supersedes' | 'conflicts_with' | 'duplicate';
  other_id: string;
  other_current_revision: number;
}

export interface MemoryDetail {
  memory: MemoryRow;
  relations: RelationRow[];
}

export interface ContextRecords {
  phase1: MemoryRow[];   // constraint + domain_rule (never budget-dropped)
  phase2: MemoryRow[];   // decision + gotcha (recency-ordered candidates)
}
```

### Interface

```ts
export interface MemoryRepository {
  /**
   * FTS + time-decay recall, project-scoped (repo-scoped when scope='repo'),
   * status='active', optional type filter, keyset paginated over (rank,id).
   * Returns the page rows, total_matches (full predicate, no keyset), and the
   * next opaque cursor (null when exhausted). Throws AppError on a malformed cursor.
   */
  recall(tenant: TenantContext, params: RecallParams): Promise<RecallResult>;

  /**
   * Fetch one active memory in the caller's project by id, plus its typed
   * relations (both directions, each other side project-scoped + active).
   * Returns null when the memory is absent / non-active / cross-project
   * (the handler maps null → opaque reference error). Does NOT read
   * memory_revision — the v1 contract exposes no revision history.
   */
  getMemoryByHandle(tenant: TenantContext, memoryId: string): Promise<MemoryDetail | null>;

  /**
   * get_context source data: phase1 (constraint/domain_rule) whole; phase2
   * (decision/gotcha) recency-ordered candidates. `stale` computed in SQL.
   * The handler applies the token budget between whole records (phase1 kept).
   */
  getContextRecords(tenant: TenantContext, phase2Limit: number): Promise<ContextRecords>;
}
```

### `PgMemoryRepository` — exact SQL

**recall** — CTE so the computed `rank` alias is filterable by the keyset predicate:

```sql
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
ranked AS (
  SELECT m.id, m.type, m.title, m.summary, m.body, m.fields,
         m.origin_branch, m.origin_pr, m.current_revision, m.updated_at,
         ts_rank_cd(m.content_tsv, q.tsq)
           / (1 + (EXTRACT(EPOCH FROM (now() - m.updated_at)) / 86400.0) / 30.0) AS rank
  FROM memory m, q
  WHERE m.project_id = $2
    AND m.status = 'active'
    AND m.content_tsv @@ q.tsq
    AND ($3::uuid IS NULL OR m.repo_id = $3)                 -- repo scope (else NULL)
    AND ($4::text[] IS NULL OR m.type = ANY($4::memory_type[]))  -- type filter
)
SELECT * FROM ranked
WHERE ($5::float8 IS NULL OR rank < $5 OR (rank = $5 AND id < $6::uuid))  -- keyset
ORDER BY rank DESC, id DESC
LIMIT $7;   -- $7 = limit + 1 (extra row detects the next page)
```
Params: `[query, projectId, scope==='repo' ? repoId : null, types ?? null, cursor?.rank ?? null, cursor?.id ?? null, limit + 1]`.

Total matches (same predicate, no keyset, no limit):
```sql
SELECT COUNT(*)::int AS total
FROM memory m, websearch_to_tsquery('english', $1) q
WHERE m.project_id = $2
  AND m.status = 'active'
  AND m.content_tsv @@ q
  AND ($3::uuid IS NULL OR m.repo_id = $3)
  AND ($4::text[] IS NULL OR m.type = ANY($4::memory_type[]));
```
Post-processing: if `rows.length === limit + 1`, drop the extra; `nextCursor =
encodeRecallCursor({ rank: kept[last].rank, id: kept[last].id })`; else `nextCursor = null`.

**getMemoryByHandle** — memory row (project-scoped, active) then relations:

```sql
-- memory row
SELECT id, type, title, summary, body, fields,
       origin_branch, origin_pr, current_revision, updated_at
FROM memory
WHERE id = $1 AND project_id = $2 AND status = 'active';
```
```sql
-- relations, both directions; the OTHER side must be same-project + active
-- (prevents leaking cross-tenant or non-active handles via an edge).
SELECT r.relation_type,
       (CASE WHEN r.from_memory = $1 THEN r.to_memory ELSE r.from_memory END) AS other_id,
       om.current_revision AS other_current_revision
FROM memory_relation r
JOIN memory om
  ON om.id = (CASE WHEN r.from_memory = $1 THEN r.to_memory ELSE r.from_memory END)
 AND om.project_id = $2
 AND om.status = 'active'
WHERE r.from_memory = $1 OR r.to_memory = $1
ORDER BY r.created_at ASC;
```
Params: `[memoryId, projectId]`. If the memory query returns 0 rows → return `null`.

**getContextRecords** — phase 1 (whole) and phase 2 (candidates), `stale` in SQL:

```sql
-- phase 1: constraints + domain_rules (never budget-dropped)
SELECT id, type, title, summary, body, fields, origin_branch, origin_pr,
       current_revision, updated_at,
       (ttl_days IS NOT NULL AND now() > created_at + make_interval(days => ttl_days)) AS stale
FROM memory
WHERE project_id = $1
  AND status = 'active'
  AND type IN ('constraint','domain_rule')
ORDER BY type ASC, updated_at DESC;
```
```sql
-- phase 2: recent decisions + gotchas (candidate set; handler trims by budget)
SELECT id, type, title, summary, body, fields, origin_branch, origin_pr,
       current_revision, updated_at,
       (ttl_days IS NOT NULL AND now() > created_at + make_interval(days => ttl_days)) AS stale
FROM memory
WHERE project_id = $1
  AND status = 'active'
  AND type IN ('decision','gotcha')
ORDER BY updated_at DESC
LIMIT $2;
```
Params: phase1 `[projectId]`, phase2 `[projectId, phase2Limit]`.

### Cursor codec (private to `memoryRepository.ts`, re-exported for the fake)

```ts
export interface RecallCursor { rank: number; id: string; }
export function encodeRecallCursor(c: RecallCursor): string; // base64url(`${rank}:${id}`)
export function decodeRecallCursor(s: string): RecallCursor;  // throws AppError on malformed
```
`id` is a UUID (no `:`), `rank` a float (no `:`) → split on `':'` is unambiguous. Malformed →
opaque `AppError` (same class as an invalid handle). Even a tampered cursor stays project-scoped
by the SQL, so it is not a security boundary — strictness is for predictability.

---

## 3. `src/mcp/handle.ts`

```ts
export interface DecodedHandle { memoryId: string; revisionNo: number; }

/** base64url("<memory_id>:<revision_no>"). Server-only; no DB column. */
export function encodeHandle(memoryId: string, revisionNo: number): string;

/** Decode + validate shape (uuid + positive int). Throws opaque AppError on malformed. */
export function decodeHandle(handle: string): DecodedHandle;

/** D3: stale iff the memory has advanced past the handle's revision. */
export function isHandleStale(currentRevision: number, decodedRevision: number): boolean;
// return currentRevision > decodedRevision;
```

Implementation notes: `encodeHandle` = `Buffer.from(`${memoryId}:${revisionNo}`,'utf8')
.toString('base64url')`. `decodeHandle` = base64url-decode → split `':'` → require exactly two
parts, part[0] matches a UUID regex, part[1] is an integer ≥ 1; otherwise throw the opaque
reference `AppError`. **Invariant (documented in-file):** a handle is valid to serve iff the
memory exists, is `active`, in the caller's project, AND `current_revision === decodedRevision`.
`isHandleStale` flags the `>` case; the handler treats BOTH `stale` (`current > decoded`) and the
impossible `current < decoded` as the same opaque reference error — never revealing which
condition failed (contract §6).

---

## 4. Services widening + edit ORDER

`AppServices` added to `src/mcp/context.ts`:

```ts
import type { MemoryRepository } from '../db/memoryRepository.js';

export interface HandlerDeps {
  memoryRepository: MemoryRepository;   // added in STEP 4 (see order)
}

export interface AppServices extends AuthServices {
  memoryRepository: MemoryRepository;   // D7 — combined bag, not overloaded AuthServices
}

// Deps already `extends HandlerDeps, AuthServices` → it inherits memoryRepository
// automatically once HandlerDeps carries it. No change to the Deps declaration body.
```

Changed signatures:
```ts
// transport.ts
export function makeMcpPostHandler(services: AppServices): (req,res,next) => Promise<void>
//   const deps: Deps = { ...services, resolutionInput };  // memoryRepository flows in via spread

// app.ts
export function createApp(services: AppServices): express.Express

// index.ts
const memoryRepository = new PgMemoryRepository(pool);
const services: AppServices = {
  authenticator, tenantResolver, authorizer, auditLogger,   // as today
  memoryRepository,
};
```

**Edit ORDER (load-bearing — build stays green at every step):**

1. **Create `src/db/memoryRepository.ts`** (interface + `PgMemoryRepository` + cursor codec).
   Compiles standalone; nothing imports it yet.
2. **Add `AppServices` to `context.ts`** (imports the `MemoryRepository` type). Do NOT touch
   `HandlerDeps` yet. `HandlerDeps` stays empty ⇒ `Deps` unchanged ⇒ everything still compiles.
3. **Widen `transport.ts` + `app.ts` to `AppServices`, and update `index.ts`** to construct
   `PgMemoryRepository(pool)` and build the `AppServices` bag. `Deps` still only requires
   `AuthServices` fields; the `AppServices` spread supplies a harmless superset ⇒ compiles.
4. **Add `memoryRepository` to `HandlerDeps`.** Now `Deps` requires it, and transport's
   `{ ...services, resolutionInput }` satisfies it *because step 3 already made `services`
   an `AppServices`*. This is the exact ordering fix — doing step 4 before step 3 breaks the
   spread (services would be `AuthServices`, missing `memoryRepository`).
5. **Rewrite the three handler bodies** (`recall`/`getMemory`/`getContext`): rename `_deps →
   deps`, call `deps.memoryRepository.*`, map via `memoryMapper`.
6. **Update tests** to seed the fake (section 7).

---

## 5. Row → contract mapping

Shared mapper `src/mcp/memoryMapper.ts` (real 3-call duplication → justified extraction):

```ts
export function toMemoryRecord(row: MemoryRow, opts?: { stale?: boolean }): MemoryRecord;
```

### MemoryRecord (`src/contracts/memory.ts`)
| Contract field | Source | Notes |
|---|---|---|
| `handle` | `encodeHandle(row.id, row.current_revision)` | always freshest revision |
| `type` | `row.type` | enum passthrough |
| `title` | `row.title` | ≤120 (DB CHECK) |
| `summary` | `row.summary` | ≤200 (DB CHECK) |
| `body` | `row.body` | ≤2000 (DB CHECK) |
| `fields` | `row.fields` | jsonb as-is (`Record<string,unknown>`) |
| `date` | `row.updated_at.toISOString()` | last promotion/amend (D4 rationale; created_at/reviewed_at rejected) |
| `origin` | `{ branch: row.origin_branch ?? '', pr: row.origin_pr ?? null }` | null branch (manual_ui) → `''` |
| `source` | hardcoded `'main'` | D1 (staging deferred) |
| `stale` | `opts?.stale` | set ONLY by get_context; omitted (undefined) for recall/get_memory |

### RecallResponse (`src/contracts/tools.ts`)
| Field | Source |
|---|---|
| `results` | `result.rows.map(r => toMemoryRecord(r))` — no `stale` |
| `total_matches` | `result.totalMatches` (COUNT query) |
| `cursor` | `result.nextCursor` (opaque; `null` when exhausted) |

### GetMemoryResponse (`src/contracts/tools.ts`)
| Field | Source |
|---|---|
| `memory` | `toMemoryRecord(detail.memory)` — handle = `encodeHandle(id, current_revision)`, source `'main'` |
| `relations` | `detail.relations.map(r => ({ type: r.relation_type, handle: encodeHandle(r.other_id, r.other_current_revision) }))` → `MemoryRelation[]` |
| `references` | de-duplicated `relations[].handle` list |

Handler pre-step: `const { memoryId } = decodeHandle(input.handle);` (opaque throw on malformed);
`const detail = await deps.memoryRepository.getMemoryByHandle(ctx.tenant, memoryId);` — if
`null` OR `isHandleStale(detail.memory.current_revision, decoded.revisionNo)` OR
`decoded.revisionNo > detail.memory.current_revision` → throw the ONE opaque reference `AppError`.

### GetContextResponse (`src/contracts/tools.ts`)
| Field | Source |
|---|---|
| `records` | `[...phase1.map(r => toMemoryRecord(r, { stale: r.stale })), ...budgetTrim(phase2)]` |

Budget: `budgetTrim` keeps phase-2 records (already recency-ordered) while a running token
estimate stays ≤ `GET_CONTEXT_TOKEN_BUDGET` (≈2500; contract §8). Estimate ≈
`ceil((title+summary+body+JSON.stringify(fields)).length / 4)`. Phase-1 records are ALWAYS
included and never counted against the drop decision (they may push the total over budget by
design — contract §2 "no se descartan por presupuesto"). Each phase-2 record mapped with its
own `stale`.

---

## 6. File structure

**Create**
| File | Purpose |
|---|---|
| `migrations/0002_memory.sql` | READ-core DDL (memory, memory_revision, memory_relation) + enums + indexes (D8); idempotent, english FTS |
| `src/db/memoryRepository.ts` | `MemoryRepository` interface + `PgMemoryRepository` + row/param types + private cursor codec |
| `src/mcp/handle.ts` | `encodeHandle`/`decodeHandle`/`isHandleStale` + invariant doc |
| `src/mcp/memoryMapper.ts` | `toMemoryRecord(row, {stale?})` shared row→contract mapper |
| `tests/memory/fakes.ts` | `InMemoryMemoryRepository` seedable fake (mirrors tests/auth/fakes.ts) |
| `tests/memory/recall.test.ts` | recall ranking / scope / type / pagination / empty |
| `tests/memory/getMemory.test.ts` | get_memory found / stale-handle / not-found / relations+references |
| `tests/memory/getContext.test.ts` | get_context ordering (phase1 first) + stale + budget trim |
| `tests/memory/handle.test.ts` | encode/decode round-trip, malformed → opaque, isHandleStale |
| `tests/memory/mapping.test.ts` | row→MemoryRecord field mapping (source main, handle, origin nulls, date) |
| `tests/db/memory.migrate.integration.test.ts` | 0002 tables/enums/indexes + FTS smoke; SKIPS without DATABASE_URL |

**Modify**
| File | Change |
|---|---|
| `src/mcp/context.ts` | add `AppServices`; add `memoryRepository` to `HandlerDeps` (STEP 2 then STEP 4) |
| `src/mcp/transport.ts` | `makeMcpPostHandler(services: AppServices)` |
| `src/http/app.ts` | `createApp(services: AppServices)` |
| `src/index.ts` | construct `PgMemoryRepository(pool)`; assemble `AppServices` |
| `src/mcp/tools/recall.ts` | real body: `deps.memoryRepository.recall` + map + cursor |
| `src/mcp/tools/getMemory.ts` | real body: decodeHandle + getMemoryByHandle + stale guard + map |
| `src/mcp/tools/getContext.ts` | real body: getContextRecords + budget trim + map |
| `src/mcp/tools/schemas.ts` | add optional `cursor` to `recallInputShape` |
| `src/contracts/tools.ts` | add optional `cursor?: string` to `RecallRequest` |
| `tests/mcp/recall.test.ts` | seed fake as `deps`; REMOVE the `source:"staged"` assertion (D1: main-only) |
| `tests/mcp/getMemory.test.ts` | seed fake; assert real record + relations shape |
| `tests/mcp/getContext.test.ts` | seed fake; assert constraint/domain_rule lead + stale |

---

## 7. Test strategy

**In-memory fake** `tests/memory/fakes.ts` — `InMemoryMemoryRepository implements
MemoryRepository`, mirroring `InMemoryAuthRepository`: constructor takes a `FakeMemory[]` seed
array (id, projectId, repoId, type, title, summary, body, fields, currentRevision, updatedAt,
ttlDays, status, originBranch, originPr) plus `FakeRelation[]`. It reuses `encodeRecallCursor`/
`decodeRecallCursor` so pagination is exercised identically.
- `recall`: filter by projectId (+repoId when scope='repo'), status='active', optional types;
  compute a deterministic rank = (query-term hits in title/summary/body) / (1 + ageDays/30);
  sort `rank DESC, id DESC`; apply keyset from decoded cursor; slice `limit+1`; build nextCursor;
  `totalMatches` = full-predicate count.
- `getMemoryByHandle`: return the active, same-project memory + relations whose other side is
  same-project + active; else `null`.
- `getContextRecords`: phase1 constraint/domain_rule (all), phase2 decision/gotcha by updatedAt
  desc capped at `phase2Limit`; compute `stale` from ttlDays vs a `now`.

**Unit tests (handlers, via the fake seeded into `deps`)**
- recall: ranking order; `scope='repo'` excludes other-repo rows; `types` filter; pagination
  (page 1 returns cursor, page 2 consumes it and reaches `cursor:null`); empty result
  (`results:[]`, `total_matches:0`, `cursor:null`); every result `source:'main'`, no `stale`.
- get_memory: found (record + relations mapped to `{type,handle}` + `references` deduped);
  stale handle (`current_revision > decoded`) → opaque `AppError`; not-found / cross-project →
  opaque `AppError`; malformed handle → opaque `AppError`; record with no edges → `relations:[]`,
  `references:[]`.
- get_context: phase-1 (constraint/domain_rule) always lead and are never dropped; phase-2 by
  recency; TTL-expired-but-active flagged `stale:true`; budget trims only phase-2.
- mapping (`tests/memory/mapping.test.ts`): `handle=encodeHandle(id,rev)`; `source:'main'`;
  `date` from `updated_at`; `origin.branch` null→`''`, `origin.pr` null preserved; `fields`
  passthrough.
- handle: encode/decode round-trip; garbage/empty/wrong-shape → opaque throw; `isHandleStale`.

**Existing handler tests (`tests/mcp/*`) stay green by**: replacing the `{} as any` deps with a
seeded `new InMemoryMemoryRepository([...])` (plus `makeStubAuthServices()` where the auth chain
is exercised via transport). One deliberate ASSERTION CHANGE: `tests/mcp/recall.test.ts` currently
asserts "at least one `source:"staged"`" against the stub — under D1 that is no longer true, so
that assertion is REMOVED and replaced by "every record `source:'main'`". This is expected: the
stub fabricated a staged record; the real handler is main-only until the write path lands.

**0002 migration integration test** (`tests/db/memory.migrate.integration.test.ts`) mirrors
`tests/db/migrate.integration.test.ts`: `const describeWithDb = process.env.DATABASE_URL ?
describe : describe.skip;` It runs `runMigrations`, asserts the 3 tables and 6 enums exist
(`to_regclass`, `pg_type typtype='e'`), asserts the `0002_memory` ledger row, and does an FTS
smoke check: insert one `memory` row (needs a `project` FK row) and assert
`content_tsv @@ websearch_to_tsquery('english', <stemmed term>)` matches (proving the english
dictionary + generated column). Tears down with `DROP ... CASCADE` (memory tables + the 6 enums)
so it stays idempotent. Skips cleanly with no DATABASE_URL.

---

## Security posture (secure-by-default)

- Every query binds `ctx.tenant.projectId` (and `repoId` for `scope='repo'`); the client never
  supplies a tenant, memory id, revision, or cursor value that reaches SQL unvalidated.
- `query`, `types`, `scope`, `branch`, `cursor`, `handle` are ALL passed as bound parameters —
  never string-concatenated into SQL. `websearch_to_tsquery('english', $1)` takes the raw query
  as a parameter.
- `get_memory` relation join enforces the other side is same-project + active → no cross-tenant
  or non-active handle leaks through an edge.
- Invalid / malformed / stale handles and malformed cursors → ONE opaque `AppError` class; no
  enumeration of other projects' memory, no signal of which condition failed (contract §6).
- Content budgets (title/summary/body) remain DB CHECK-enforced by the DDL.
