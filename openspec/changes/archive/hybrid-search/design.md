# Design: hybrid-search (two-phase — lexical-first, semantic fallback)

schema: design-v1
change: hybrid-search
status: DESIGNED
date: 2026-07-31
supersedes: design-v1 (fusion-always) — REPLACED after the user pivot to two-phase
based_on: proposal.md (proposal-v1, revised) + exploration.md (exploration-synthesis-v1)

## Technical Approach

Recall stays **BM25-first and zero-cost in the common case**. The existing
`memoryRepository.recall` (FTS + time-decay + keyset cursor + parallel COUNT) is
**UNCHANGED** — same SQL, same `RecallCursor { rank, id }` codec, same `pageParams`
($1–$7), same `RECALL_COUNT_SQL`. We do **not** rename `rank→score`, and we do **not**
add a `queryEmbedding` param to `recall`.

The semantic signal is added as a **second phase orchestrated in the recall handler**
(`src/mcp/tools/recall.ts`), and only when three conditions all hold:

1. it is the **first page** (`cursor === null`), and
2. **BM25 came up short** — the (already-computed, free) `result.totalMatches`
   is `< SEMANTIC_FALLBACK_MIN_RESULTS` (N, default 5), and
3. the **query embedding succeeds** (fail-soft: any embed error → skip Phase 2).

When Phase 2 runs, the handler embeds the query via the injected `Embedder` and calls a
**new** repository method `recallSemantic(tenant, queryEmbedding, filters, excludeIds, k)`
— a pure vector nearest-neighbour scan (`ORDER BY embedding <=> $qvec LIMIT k`, NOT
FTS-gated) that uses the HNSW index, is tenant-scoped, filters `status='active'` and
`embedding IS NOT NULL`, applies the identical repo/type filters as Phase 1, and excludes
the ids Phase 1 already returned. Its hits are **appended** after the BM25 results as
first-page-only extras — mirroring the existing staging-mix.

Embeddings are computed at **write time** (`PromoteService`, fail-soft → NULL) and stored
in a nullable `embedding vector(1024)` column added by migration `0005`, so Phase 2 has
data to match. Everything is locally runnable with a deterministic `StubEmbedder`
(`node:crypto`, no dependency); the real `BedrockEmbedder` is a deferred skeleton that
throws. Fail-soft lives entirely in the **callers** (recall handler read path,
PromoteService write path) — recall never 500s, promotion never blocks.

Three refinements this design pins on top of the proposal, all grounded in the current
code (see exploration report): (1) the fallback trigger is `result.totalMatches < N`, not
`rows.length < N` — equivalent when `limit ≥ N` but robust when a caller requests a tiny
page (Decision 1); (2) `recallSemantic`'s filter object takes `scope` (not a pre-derived
`repoId`) so the `scope → repo_id` rule stays in ONE layer, identical to `recall`
(Decision 3); (3) `HandlerDeps` must be widened — the recall handler receives
`HandlerDeps`, which today carries only `memoryRepository` + `stagingRepository`
(Decision 6).

## Architecture Decisions

### Decision 1: Two-phase in the handler; BM25 `recall` untouched

**Choice**: Orchestrate the two phases in `recallHandler`. Phase 1 is the existing
`memoryRepository.recall(...)` **verbatim**. Phase 2 is a new `recallSemantic(...)` repo
method the handler calls only under the gate below. The trigger is:

```
cursor === null  &&  result.totalMatches < SEMANTIC_FALLBACK_MIN_RESULTS
```

`result.totalMatches` is the value already returned by the unchanged parallel
`RECALL_COUNT_SQL` (the true count of BM25 FTS matches). On subsequent pages
(`cursor !== null`) Phase 2 never runs — keyset pagination stays exactly as today.

**Alternatives considered**:
- *Trigger on `result.rows.length < N`* (the proposal's literal phrasing). Equivalent to
  `totalMatches < N` whenever `limit ≥ N` (default `limit=8 ≥ N=5`), because on the first
  page `rows.length = min(totalMatches, limit)`. But if a caller requests `limit < N`,
  `rows.length` can never reach `N` and semantic fallback would fire spuriously on every
  such query. `totalMatches` is already computed (free) and expresses the real question —
  "was lexical confident?" — independent of page size.
- *Score-threshold trigger* (fire when top BM25 rank `< τ`). Deferred: `< N` is simpler and
  more predictable for the pilot, and needs no rank-scale calibration.
- *Fusion-always in-SQL* (the superseded design). Rejected by the user pivot: it put an
  embedding call on **every** read, rewrote the ranked query (`rank→score`, `$8`), and left
  the HNSW index unused (an FTS-gated composite `ORDER BY` cannot use it).

**Rationale**: the common case (BM25 has ≥ N matches) makes **zero** embedding calls and
touches no changed SQL — the lowest-risk, lowest-cost path. Only weak-lexical queries pay
for one embedding, exactly when semantics adds value, and Phase 2's pure `<=> LIMIT k`
actually uses the HNSW index. Keeping `recall` byte-for-byte identical means the keyset
cursor contract, COUNT semantics, and every existing recall test remain valid.

### Decision 2: `total_matches` = BM25 FTS count; semantic hits are additive extras

**Choice**: The handler returns `total_matches = result.totalMatches` (the BM25 FTS COUNT),
**unchanged**. Vector-fallback rows are appended to `results` but are **not** added to
`total_matches`. They are first-page-only extras, exactly like staged drafts today (the
handler already documents that staged items are additive and not counted).

**Alternatives considered**: `total_matches = bm25Count + semanticHits.length`. Rejected —
it would break the invariant that `total_matches` drives keyset pagination over the BM25
ranklist (semantic hits are not paginated and not part of the cursor'd set), producing an
inconsistent count on page 1 vs. page 2+.

**Rationale**: `total_matches` describes the paginable BM25 result set; conflating it with
un-paginated extras is misleading and breaks the cursor contract. Observability for "how
many semantic hits were appended" is a cheap server-side `logger.debug` count, not a wire
field.

### Decision 3: `recallSemantic` signature + exact NN SQL

**Choice**: Add to the `MemoryRepository` interface (and `PgMemoryRepository`):

```ts
export interface RecallSemanticFilters {
  scope: 'repo' | 'project';   // derived to repo_id INSIDE the repo, identical to recall
  types?: MemoryType[];
}

recallSemantic(
  tenant: TenantContext,
  queryEmbedding: number[],          // non-null — handler only calls this when embed succeeded
  filters: RecallSemanticFilters,
  excludeIds: string[],              // Phase-1 ids to exclude (may be empty → excludes nothing)
  k: number,                         // SEMANTIC_FALLBACK_K
): Promise<MemoryRow[]>;             // NN order; no cursor, no count (they are extras)
```

Exact parameterized SQL (`RECALL_SEMANTIC_SQL`):

```sql
SELECT m.id, m.type, m.title, m.summary, m.body, m.fields,
       m.origin_branch, m.origin_pr, m.current_revision, m.updated_at
FROM memory m
WHERE m.project_id = $1
  AND m.status = 'active'
  AND m.embedding IS NOT NULL
  AND ($2::uuid IS NULL OR m.repo_id = $2)
  AND ($3::text[] IS NULL OR m.type = ANY($3::memory_type[]))
  AND m.id <> ALL($4::uuid[])
ORDER BY m.embedding <=> $5::vector
LIMIT $6
```

Params (built in the repo, mirroring `recall`'s derivation):

```ts
const repoIdParam = filters.scope === 'repo' ? tenant.repoId : null; // SAME rule as recall
const typesParam  = filters.types && filters.types.length ? filters.types : null;
const params = [
  tenant.projectId,                    // $1
  repoIdParam,                         // $2 — null → project scope (identical to recall)
  typesParam,                          // $3 — null → all types
  excludeIds,                          // $4 — uuid[]; [] → `id <> ALL('{}')` is TRUE for all rows
  toVectorParam(queryEmbedding),       // $5 — '[...]' vector literal (never null on this path)
  k,                                   // $6
];
```

- **`<=>`** is the cosine-distance operator (matches the index's `vector_cosine_ops`);
  `ORDER BY … <=> q ASC LIMIT k` returns the nearest rows and is exactly the shape the
  HNSW partial index accelerates. The `embedding IS NOT NULL` predicate lines up with the
  partial index's `WHERE embedding IS NOT NULL`, so the planner can use it.
- **Dedupe** is enforced in SQL via `id <> ALL($4::uuid[])` (excludeIds = the Phase-1 row
  ids). Since the trigger only fires when `totalMatches < N`, on the first page all BM25
  matches are on the page, so `excludeIds` covers the entire BM25 set. The handler also
  builds `excludeIds` from `result.rows` so the two never overlap.
- **Row shape reuse**: the SELECT returns the same columns as `RECALL_PAGE_SQL` minus
  `rank`. Extract a module-private `mapRow(raw): MemoryRow` (the mapping that `recall`
  currently inlines at lines 336–347) and reuse it for both `recall` and `recallSemantic`
  → `MemoryRow[]`. The handler maps those to the contract via the existing
  `toMemoryRecord(row)` → `source: "main"` (Decision 5).

**Alternatives considered**: pass a pre-derived `repoId: string | null` in the filters
(the proposal's `{ repoId, types }` sketch). Rejected — that duplicates the
`scope === 'repo' ? tenant.repoId : null` rule in the handler while `recall` keeps it in
the repo, inviting drift. Passing `scope` keeps the derivation in exactly one layer, which
is the strongest reading of the proposal's "repo/type filters identical to Phase 1".

**Rationale**: a pure NN method keeps `PgMemoryRepository` SQL-only, returns plain
`MemoryRow[]` (no cursor/count coupling), and is the only query in the system that actually
exercises the HNSW index.

### Decision 4: Read-time fail-soft — embed error → skip Phase 2 (BM25-only)

**Choice**: The handler wraps `deps.embedder.embed(input.query)` in try/catch **inside** the
Phase-2 gate. On any error it logs a warn and skips Phase 2 entirely, returning the BM25
results as-is. `recallSemantic` is only ever called with a successfully-computed vector, so
it never has to reason about a null query embedding. A read-time embed failure therefore
**never 500s** recall — it silently degrades to lexical-only.

**Alternatives considered**: embed the query up-front (before the gate) so it is available
unconditionally. Rejected — that would embed on the common (BM25-confident) path too,
defeating the entire cost rationale of two-phase.

**Rationale**: fail-soft plus lazy-embed. The embed call happens only when we have already
decided we need it and only if it succeeds; otherwise the user still gets lexical results.

### Decision 5: `source` tag — vector rows are authoritative → `source:"main"`

**Choice**: Phase-2 rows are real, promoted `memory` records, so they flow through the
existing `toMemoryRecord(row)` mapper, which hard-codes `source: "main"`. No wire-level
marker distinguishes a BM25 hit from a vector-fallback hit. Observability is a cheap
`logger.debug('[recall] semantic fallback appended N hit(s)')` on the server side only.

**Alternatives considered**: add an internal `source:"semantic"` (or a boolean flag) to the
`MemoryRecord` contract. Rejected as not-cheap — it would change the facade contract type
(`src/contracts/*`) and every consumer/serializer for pilot-only observability that a log
line already provides.

**Rationale**: vector-fallback rows are indistinguishable from lexical rows *by design* —
both are governed main memories. Keep the wire contract unchanged (error-opacity /
contract-stability), add the observability server-side.

### Decision 6: Merge order + Phase-2 placement — staged, then BM25, then semantic

**Choice**: The handler returns, on the **first page** (`cursor === null`):

```
results = [ ...stagedRecords, ...bm25Records, ...semanticRecords ]
```

On subsequent pages (`cursor !== null`): `results = [ ...bm25Records ]` — no staged, no
semantic (both are first-page-only). This preserves the current staging-mix ordering
(staged first) and simply appends the semantic extras last.

`HandlerDeps` must gain the embedder and the two thresholds, because the recall handler
sees `HandlerDeps` (today only `{ memoryRepository, stagingRepository }`), **not**
`AppServices`:

```ts
export interface HandlerDeps {
  memoryRepository: MemoryRepository;
  stagingRepository: StagingRepository;
  embedder: Embedder;                    // NEW — recall handler embeds the query (Phase 2)
  semanticFallbackMinResults: number;    // NEW — N (config)
  semanticFallbackK: number;             // NEW — k (config)
}
```

**Alternatives considered**: (a) import a config singleton inside the handler for N/k.
Rejected — handlers are pure functions taking `deps` (see how `DEFAULT_LIMIT`/`MAX_LIMIT`
are the only handler-local constants); threading N/k through `deps` keeps them unit-testable
with small values. (b) Put semantic hits before BM25. Rejected — BM25 is the primary,
higher-precision signal; semantic is the rescue, so it goes last.

**Rationale**: mirrors the existing, well-understood staging-mix pattern (first-page-only
additive extras), keeps handlers pure and hermetically testable, and keeps precedence
(staged drafts you just wrote > confident lexical > semantic rescue) intuitive.

### Decision 7: Migration 0005 — extension + column + HNSW partial index, in one txn

**Choice**: `migrations/0005_embeddings.sql` (idempotent) creates the `vector` extension,
the nullable `embedding vector(1024)` column, and an **HNSW partial index** using
`vector_cosine_ops`. The migration runner (`src/db/migrate.ts:79–90`) wraps each file in a
single `BEGIN/COMMIT`, which is txn-safe for **non-CONCURRENTLY** DDL and **forbids**
`CREATE INDEX CONCURRENTLY` here.

**HNSW is now ON the hot path** — Phase 2's `ORDER BY embedding <=> q LIMIT k` is exactly
the query the HNSW index accelerates (this is the key upside of the two-phase pivot vs. the
superseded fusion-always plan, where the FTS-gated composite `ORDER BY` could not use it).

**Alternatives considered**: (a) column only, defer the index. Rejected — Phase 2 depends on
it for the intended NN acceleration, and validating the extension + partial-index build +
superuser/lock caveats on the empty pilot table is a stated de-risking goal. (b) IVFFlat.
Rejected — IVFFlat needs training data (a populated table) to build sane lists; HNSW builds
correctly on an empty table.

**Rationale**: HNSW-on-empty-table is correct and now load-bearing; the per-file txn hard-
confirms non-CONCURRENTLY for the pilot; the ops caveats (superuser, live-table
CONCURRENTLY rollout) are documented in the header and DEFERRED.

### Decision 8: Write-path fail-soft — embed before `applyAccepted`; error → NULL

**Choice**: In `PromoteService.promote`, inside the `verdict === 'accepted'` branch and
**before** `promotionRepository.applyAccepted(...)`, compute the embedding for
`add`/`amend`/`supersede` only (skip `deprecate` — no content change). Wrap
`embedder.embed(`${item.title}\n${item.summary}\n${item.body}`)` in try/catch; on any error
log a warn and pass `null`. `applyAccepted` gains a third param `embedding: number[] | null`.
A write-time embed failure therefore **never blocks, quarantines, or 500s** the promotion —
the row is written with `embedding = NULL` and remains fully BM25-searchable (it is simply
invisible to Phase 2 until re-embedded).

**Alternatives considered**: compute in `PgPromotionRepository`, or fail the item on embed
error. Rejected — the DB seam stays pure SQL, and coupling memory durability to an optional
signal (and to AWS availability in prod) violates fail-soft.

**Rationale**: mirrors the existing decision to compute at the service layer (like the
judge), keeps the repo pure, and guarantees the write path never depends on the embedder.

### Decision 9: `EMBEDDING_DIM=1024` + deterministic StubEmbedder; BedrockEmbedder THROWS

**Choice**: `EMBEDDING_DIM = 1024` (Bedrock Titan Text Embeddings V2) exported once from
`src/embedder/embedder.ts` — the single source of truth for the column dimension, the stub
output length, and test assertions. Hard lock-in once data is written (documented).
`StubEmbedder` is fully deterministic via a `node:crypto` sha256 chain → L2-normalized
1024-float unit vector (no dependency, no AWS), so ranking/integration fixtures are
reproducible.

**Unlike `BedrockJudge`** (which fails *closed* to the valid verdict `'uncertain'`),
`BedrockEmbedder.embed` **THROWS** — there is no valid "fallback vector" it could fabricate
without silently corrupting semantic search. Fail-soft (→ NULL / skip Phase 2) therefore
lives at the **callers** (Decisions 4 and 8), deliberately and documented.

**Alternatives considered**: 1536-dim (OpenAI-style) or 512-dim. Rationale: 1024/Titan-v2
aligns with the existing Bedrock usage (`BedrockJudge`) and keeps the deferred real embedder
a drop-in.

## Data Flow

Write path (promotion — unchanged except the embed step):

    staging_item (accepted)
         │
         ▼
    PromoteService.promote ── item.op ∈ {add,amend,supersede} ──▶ embedder.embed(title\nsummary\nbody)
         │                                                             │  (try/catch → null on error)
         │  item.op == deprecate → skip embed (embedding = null)       ▼
         └───────────────────────────────────────────────────▶ applyAccepted(item, ctx, embedding)
                                                                       │
                                                                       ▼
                                       INSERT/AMEND SQL: embedding = $12::vector (or NULL)

Read path (recall — TWO-PHASE):

    recall input {query, scope, types, limit, cursor}
         │
         ▼
    [Phase 1]  memoryRepository.recall(tenant, params)     ← UNCHANGED (FTS+decay+keyset+COUNT)
         │        rows: MemoryRow[]   totalMatches   nextCursor
         │
         ├── cursor !== null ───────────────────────────────────────────┐  (page 2+: BM25 only)
         │                                                               │
         └── cursor === null                                             │
                 │                                                       │
                 ├── totalMatches >= N ──▶ NO embed, NO Phase 2          │
                 │                                                       │
                 └── totalMatches <  N ──▶ [Phase 2]                     │
                          embedder.embed(query)                         │
                              │  try/catch                              │
                     ┌────────┴─────────┐                              │
                  (throws)          (ok → vec)                         │
                     │                  │                              │
              skip Phase 2      recallSemantic(tenant, vec,            │
              (BM25 only)         {scope,types}, excludeIds=bm25 ids, k)│
                     │                  │  ORDER BY embedding <=> vec   │
                     │                  ▼  LIMIT k  (HNSW, dedup in SQL)│
                     │           semanticRows: MemoryRow[]              │
                     ▼                  ▼                              ▼
              results = [ ...staged(page1), ...bm25, ...semantic ]   results = [ ...bm25 ]
              total_matches = totalMatches (BM25 FTS count; extras NOT counted)
              cursor        = nextCursor (BM25 keyset — unchanged)

## Contracts

### migrations/0005_embeddings.sql (exact DDL)

```sql
-- 0005_embeddings.sql — pgvector column + HNSW index for two-phase (lexical→semantic) recall.
--
-- OPS CAVEATS (read before applying to a non-pilot environment):
--   * CREATE EXTENSION vector requires rds_superuser on RDS. If the role lacks it,
--     this migration fails and the runner's per-file transaction (src/db/migrate.ts)
--     rolls back cleanly (schema_migrations is NOT updated) — grant rds_superuser
--     out-of-band, then re-run.
--   * The migration runner executes each file inside ONE BEGIN/COMMIT. CREATE INDEX
--     CONCURRENTLY is therefore FORBIDDEN here (it cannot run in a transaction). The
--     non-CONCURRENTLY HNSW build below takes an ACCESS EXCLUSIVE lock — safe on the
--     pilot's empty/tiny table. A live-table prod rollout MUST use a separate
--     out-of-transaction CONCURRENTLY migration (DEFERRED).
--   * This HNSW index IS on the hot path: it accelerates the Phase-2 vector-only NN
--     query (ORDER BY embedding <=> q LIMIT k) in memoryRepository.recallSemantic.
--     It adds write-amplification (graph maintenance) on every embedded INSERT/UPDATE;
--     negligible at pilot volume.
--   * Dimension 1024 (Bedrock Titan Text Embeddings V2) is a HARD lock-in once data is
--     written — changing it requires re-embedding every row. Keep in sync with
--     EMBEDDING_DIM in src/embedder/embedder.ts.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw
  ON memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
```

### src/embedder/embedder.ts (interface + dim)

```ts
/** Single source of truth for the embedding dimension (Bedrock Titan Text Embeddings V2). */
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** Returns an EMBEDDING_DIM-length vector. MAY throw; callers implement fail-soft. */
  embed(text: string): Promise<number[]>;
}
```

### src/db/vector.ts (shared pg `vector` serializer)

```ts
/** Format a JS vector as a pgvector literal, or NULL. Shared by recallSemantic ($qvec) and promotion. */
export function toVectorParam(vec: number[] | null): string | null {
  return vec === null ? null : `[${vec.join(',')}]`;
}
```

### src/embedder/stubEmbedder.ts (deterministic algorithm)

```ts
// DEV/TEST-ONLY. Deterministic, dependency-free pseudo-embedding. NOT semantic —
// same input always yields the same unit vector; used for reproducible ranking/integration tests.
import { createHash } from 'node:crypto';
import { EMBEDDING_DIM, type Embedder } from './embedder.js';

export class StubEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const out = new Array<number>(EMBEDDING_DIM);
    let block = Buffer.alloc(0);
    let offset = 0;
    let counter = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      if (offset + 4 > block.length) {
        block = createHash('sha256').update(`${text}:${counter++}`).digest(); // 32 bytes → 8 int32
        offset = 0;
      }
      out[i] = block.readInt32BE(offset) / 2147483648; // → [-1, 1)
      offset += 4;
    }
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return out.map((v) => v / norm); // L2-normalized unit vector
  }
}
```

### src/embedder/bedrockEmbedder.ts (deferred skeleton — THROWS; callers catch)

```ts
import { EMBEDDING_DIM, type Embedder } from './embedder.js';

export class BedrockEmbedder implements Embedder {
  constructor(private readonly modelId: string) {}

  async embed(text: string): Promise<number[]> {
    // NOTE: unlike BedrockJudge (fail-CLOSED to a valid verdict), this does NOT swallow errors —
    // a fabricated vector would silently corrupt semantic search. Callers implement fail-soft.
    return this.invokeModel(text);
  }

  private async invokeModel(_text: string): Promise<number[]> {
    // DEFERRED: real Bedrock InvokeModel (Titan v2) via VPC PrivateLink + IAM + @aws-sdk/*.
    // Must return an EMBEDDING_DIM (1024)-length array.
    void EMBEDDING_DIM;
    throw new Error('BedrockEmbedder.invokeModel not implemented (deferred)');
  }
}
```

### src/db/memoryRepository.ts — ADD `recallSemantic`; `recall` UNCHANGED

`recall`, `RecallParams`, `RecallResult`, `RecallCursor { rank, id }`,
`encode/decodeRecallCursor`, `RECALL_PAGE_SQL`, `RECALL_COUNT_SQL`, and `pageParams` ($1–$7)
are **untouched**. Additions only:

- `RecallSemanticFilters` type + `recallSemantic` on the `MemoryRepository` interface and
  `PgMemoryRepository` (signature + `RECALL_SEMANTIC_SQL` + params in Decision 3).
- A module-private `mapRow(raw): MemoryRow` extracted from `recall`'s current inline map
  (lines 336–347) and reused by both `recall` and `recallSemantic`. `recall`'s `RawPageRow`
  keeps its extra `rank` field; the semantic SELECT returns the same columns minus `rank`,
  so `mapRow` (which never reads `rank`) works for both.
- Import `toVectorParam` from `src/db/vector.js`.

### src/db/promotionRepository.ts — INSERT / AMEND embedding param

`applyAccepted(item, ctx)` → `applyAccepted(item, ctx, embedding: number[] | null)`.

`INSERT_MEMORY_SQL` (used by `add` **and** `supersede` for the new row): append `embedding`
to the column list and `$12::vector` to `VALUES`; bind `toVectorParam(embedding)` as `$12`
(existing params $1–$11 unchanged):

```sql
INSERT INTO memory
  (project_id, repo_id, type, title, summary, body, fields,
   status, provenance, author_identity, content_hash, current_revision,
   origin_branch, origin_pr, embedding)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
        'active', 'pr_reviewed', $8, $9, 1, $10, $11, $12::vector)
ON CONFLICT (project_id, content_hash) DO NOTHING
RETURNING id
```

`UPDATE_MEMORY_AMEND_SQL` (used by `amend`): add `embedding = $12::vector` to the SET list;
bind `toVectorParam(embedding)` as `$12` (existing `$10=memory_id`, `$11=project_id`
unchanged):

```sql
UPDATE memory
SET title = $1, summary = $2, body = $3, fields = $4::jsonb, type = $5,
    content_hash = $6, author_identity = $7, provenance = 'pr_reviewed',
    origin_branch = $8, origin_pr = $9, embedding = $12::vector,
    current_revision = current_revision + 1, updated_at = now()
WHERE id = $10 AND project_id = $11
```

`$12` is `NULL` when the embed failed → `$12::vector` = SQL NULL. The **`deprecate` UPDATE +
revision insert are UNCHANGED** (no content change → no embedding). `content_tsv` remains
`GENERATED ALWAYS` — never in a column/SET list. Import `toVectorParam` from
`src/db/vector.js`.

### src/promote/promoteService.ts — promote() change

Constructor deps bag gains `embedder: Embedder`
(`{ promotionRepository, judge, auditLogger, embedder }`). Inside the
`verdict === 'accepted'` branch, before `applyAccepted`:

```ts
if (verdict === 'accepted') {
  let embedding: number[] | null = null;
  if (item.op !== 'deprecate') {
    try {
      embedding = await this.deps.embedder.embed(`${item.title}\n${item.summary}\n${item.body}`);
    } catch {
      logger.warn(`[promote] embedding failed for item ${item.id} — writing NULL (fail-soft)`);
      embedding = null;
    }
  }
  const r = await promotionRepository.applyAccepted(item, ctx, embedding);
  // ...existing switch on r.status (applied/stale/duplicate/already) UNCHANGED...
}
```

### src/config/index.ts — env + superRefine (mirror the judge guards)

```ts
// zod schema additions:
EMBEDDER_STUB: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
BEDROCK_EMBEDDING_MODEL_ID: z.string().min(1).optional(),
SEMANTIC_FALLBACK_MIN_RESULTS: z.coerce.number().int().min(1).default(5), // N
SEMANTIC_FALLBACK_K: z.coerce.number().int().positive().default(8),        // k
```
```ts
// in superRefine (mirrors the JUDGE_STUB pair at lines 95–112):
if (cfg.EMBEDDER_STUB && cfg.NODE_ENV === 'production') {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EMBEDDER_STUB'],
    message: 'EMBEDDER_STUB=true is forbidden when NODE_ENV=production.' });
}
if (!cfg.EMBEDDER_STUB && !cfg.BEDROCK_EMBEDDING_MODEL_ID) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BEDROCK_EMBEDDING_MODEL_ID'],
    message: 'BEDROCK_EMBEDDING_MODEL_ID is required when EMBEDDER_STUB is not true.' });
}
```

### src/index.ts — composition root (mirror the judge if/else + banner, lines 106–157)

```ts
let embedder: Embedder;
if (config.EMBEDDER_STUB && config.NODE_ENV !== 'production') {
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] EMBEDDER_STUB ACTIVE — StubEmbedder (deterministic, non-semantic).');
  logger.warn('[boot] Embeddings are pseudo-random. DEV/TEST ONLY.');
  logger.warn('[boot] Set EMBEDDER_STUB=false (and provide BEDROCK_EMBEDDING_MODEL_ID) for production.');
  logger.warn('════════════════════════════════════════════════════════════');
  embedder = new StubEmbedder();
} else {
  // superRefine guarantees BEDROCK_EMBEDDING_MODEL_ID is present on this path.
  embedder = new BedrockEmbedder(config.BEDROCK_EMBEDDING_MODEL_ID!);
}

const promoteService = new PromoteService({ promotionRepository, judge, auditLogger, embedder });

const services: AppServices = {
  // ...existing fields (lines 145–157)...
  embedder,                                                  // NEW
  semanticFallbackMinResults: config.SEMANTIC_FALLBACK_MIN_RESULTS, // NEW
  semanticFallbackK: config.SEMANTIC_FALLBACK_K,             // NEW
};
```

### src/mcp/context.ts — AppServices + HandlerDeps

```ts
export interface AppServices extends AuthServices {
  // ...existing fields...
  promoteService: PromoteService;
  embedder: Embedder;                    // NEW — shared by write (PromoteService) & read (recall)
  semanticFallbackMinResults: number;    // NEW — N
  semanticFallbackK: number;             // NEW — k
}

export interface HandlerDeps {
  memoryRepository: MemoryRepository;
  stagingRepository: StagingRepository;
  embedder: Embedder;                    // NEW
  semanticFallbackMinResults: number;    // NEW
  semanticFallbackK: number;             // NEW
}
```

`Deps extends HandlerDeps, AuthServices`. The per-request `Deps` assembly (the spread of
`AppServices`, in the MCP post-handler — `src/mcp/server.ts` / `src/http/app.ts`, NOT in
`context.ts`) must now carry `embedder`, `semanticFallbackMinResults`, and
`semanticFallbackK`. **Worker verifies the assembly site includes them** (if it spreads
`...services`, they flow automatically; if it lists fields explicitly, add them).

### src/mcp/tools/recall.ts — two-phase orchestration (Phase 1 call is UNCHANGED)

```ts
export async function recallHandler(
  input: RecallRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<RecallResponse> {
  const scope: 'repo' | 'project' = input.scope ?? 'project';
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = input.cursor ?? null;
  const types = input.types && input.types.length ? input.types : undefined;

  // Phase 1 — BM25 (existing recall, UNCHANGED)
  const result = await deps.memoryRepository.recall(ctx.tenant, { query: input.query, scope, types, limit, cursor });
  const bm25Records = result.rows.map((row) => toMemoryRecord(row));

  // Phase 2 — semantic fallback: first page only, only when BM25 came up short, fail-soft
  let semanticRecords: MemoryRecord[] = [];
  if (cursor === null && result.totalMatches < deps.semanticFallbackMinResults) {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await deps.embedder.embed(input.query);
    } catch {
      logger.warn('[recall] query embedding failed — skipping semantic fallback (BM25-only)');
    }
    if (queryEmbedding !== null) {
      const excludeIds = result.rows.map((r) => r.id);
      const vectorRows = await deps.memoryRepository.recallSemantic(
        ctx.tenant, queryEmbedding, { scope, types }, excludeIds, deps.semanticFallbackK,
      );
      semanticRecords = vectorRows.map((row) => toMemoryRecord(row));
      if (semanticRecords.length) {
        logger.debug(`[recall] semantic fallback appended ${semanticRecords.length} hit(s)`);
      }
    }
  }

  // Staged-mix: first page only (UNCHANGED)
  const stagedRecords: MemoryRecord[] = cursor === null
    ? (await deps.stagingRepository.listStagingItems(ctx.tenant)).map((item) => toStagedRecord(item, ctx.tenant.branch))
    : [];

  return {
    results: [...stagedRecords, ...bm25Records, ...semanticRecords],
    total_matches: result.totalMatches,   // BM25 FTS count; semantic hits are additive extras
    cursor: result.nextCursor,             // BM25 keyset cursor — UNCHANGED
  };
}
```

### tests/memory/fakes.ts — add `recallSemantic` (deterministic)

`FakeMemory` gains an optional `embedding?: number[]`. The existing `recall` fake (with
`computeRank`, keyset, cursor codec reuse) is **unchanged**. Add a `recallSemantic` that:
filters `status === 'active'` + `projectId` match + (scope=repo → `repoId` match) +
optional `types` + `embedding != null` + `id ∉ excludeIds`; ranks by **cosine similarity**
to `queryEmbedding` descending (deterministic — `dot(a,b) / (|a||b|)`; the seeded vectors
and the StubEmbedder are both deterministic); returns the top `k` mapped to `MemoryRow`.
This makes the two-phase handler test hermetic (no DB, no AWS) and ensures a broken
Phase-2 wiring cannot silently pass.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `migrations/0005_embeddings.sql` | Create | `CREATE EXTENSION vector` + `embedding vector(1024)` + HNSW partial index (`vector_cosine_ops`); header documents superuser / non-CONCURRENTLY-per-file-txn / dim-lock / **HNSW-now-on-hot-path** caveats |
| `src/embedder/embedder.ts` | Create | `Embedder` interface + `EMBEDDING_DIM = 1024` |
| `src/embedder/stubEmbedder.ts` | Create | Deterministic `node:crypto` sha256-chain → L2-normalized 1024-float unit vector; DEV/TEST banner |
| `src/embedder/bedrockEmbedder.ts` | Create | Deferred skeleton; `invokeModel` THROWS; no aws-sdk |
| `src/db/vector.ts` | Create | `toVectorParam(vec) → '[...]' | null` pg-vector serializer (shared by recallSemantic + promotion) |
| `src/config/index.ts` | Modify | `EMBEDDER_STUB`, `BEDROCK_EMBEDDING_MODEL_ID`, `SEMANTIC_FALLBACK_MIN_RESULTS` (5), `SEMANTIC_FALLBACK_K` (8) + 2 superRefine guards |
| `src/db/memoryRepository.ts` | Modify | ADD `RecallSemanticFilters` + `recallSemantic` (interface + impl + `RECALL_SEMANTIC_SQL`); extract shared `mapRow`; import `toVectorParam`. **`recall`/cursor/COUNT UNCHANGED** |
| `src/db/promotionRepository.ts` | Modify | `applyAccepted(+embedding)`; `INSERT_MEMORY_SQL` + `UPDATE_MEMORY_AMEND_SQL` add `embedding = $12::vector`; deprecate unchanged; import `toVectorParam` |
| `src/promote/promoteService.ts` | Modify | Constructor `+embedder`; compute embedding fail-soft before `applyAccepted` for add/amend/supersede (skip deprecate) |
| `src/mcp/context.ts` | Modify | `embedder` + `semanticFallbackMinResults` + `semanticFallbackK` added to `AppServices` and `HandlerDeps` |
| `src/index.ts` | Modify | Embedder if/else + WARN banner; `PromoteService` gets `embedder`; `AppServices` assembly gets the 3 new fields |
| `src/mcp/server.ts` / `src/http/app.ts` | Modify | Per-request `Deps` assembly carries the 3 new fields (worker locates the exact site) |
| `src/mcp/tools/recall.ts` | Modify | Two-phase orchestration (Phase-1 call unchanged; Phase-2 gate + fail-soft embed + `recallSemantic` + append) |
| `tests/memory/fakes.ts` | Modify | `FakeMemory.embedding?`; add deterministic `recallSemantic` (cosine); existing `recall` fake unchanged |
| `tests/embedder/stubEmbedder.test.ts` | Create | Determinism + dim + unit-norm |
| `tests/embedder/failSoft.test.ts` | Create | `BedrockEmbedder.embed` throws; throwing fake drives caller fail-soft |
| `tests/config/embedderGuards.test.ts` | Create | superRefine matrix + numeric defaults/coercion |
| `tests/memory/recallTwoPhase.test.ts` | Create | Handler cases (≥N no-embed / <N embed+append+dedupe / embed-fail→BM25 / cursor page→no phase2) |
| `tests/promote/promoteEmbedding.test.ts` | Create | Promote writes embedding; embed error → NULL, still applied; deprecate skips embed |
| `tests/integration/hybridSearch.int.test.ts` | Create | DB-gated: extension/column/index exist; `recallSemantic` returns vector-near row via HNSW; NULL-embedding excluded |

## Test Plan

**Unit (hermetic — no DB, no AWS)**
- `stubEmbedder.test.ts`: same input → identical vector (determinism); `length === EMBEDDING_DIM`
  (1024); L2 norm ≈ 1; distinct inputs → distinct vectors.
- `failSoft.test.ts`: `new BedrockEmbedder('m').embed('x')` rejects; a `ThrowingEmbedder` fake
  makes `PromoteService` write NULL and makes the recall handler skip Phase 2 (no throw escapes).
- `embedderGuards.test.ts`: `EMBEDDER_STUB=true` + `NODE_ENV=production` → config error;
  `EMBEDDER_STUB=false` with no `BEDROCK_EMBEDDING_MODEL_ID` → error; happy paths pass;
  `SEMANTIC_FALLBACK_MIN_RESULTS`/`_K` default to 5/8 and coerce from strings.
- `recallTwoPhase.test.ts` (uses `InMemoryMemoryRepository` + a spy/counting `Embedder`):
  - **≥ N → no embed**: seed so `totalMatches >= N`; assert `embedder.embed` **not called**,
    `recallSemantic` **not called**, `results = [...staged, ...bm25]`, `total_matches` = BM25 count.
  - **< N → embed + append + dedupe**: seed so `totalMatches < N` with a semantically-near row
    (via the fake's cosine); assert `embed` called **once**, `recallSemantic` called with
    `excludeIds` = the BM25 ids and `k = SEMANTIC_FALLBACK_K`, `results` end with the semantic
    rows, no id appears twice, `total_matches` = BM25 count (NOT incremented by extras).
  - **embed fails → BM25-only**: throwing embedder; assert no throw escapes, `recallSemantic`
    not called, `results = [...staged, ...bm25]`.
  - **cursor page → no Phase 2**: `cursor !== null` even with `totalMatches < N`; assert no
    embed, no `recallSemantic`, no staged, `results = [...bm25]`, cursor round-trips.
- `promoteEmbedding.test.ts`: accepted add/amend/supersede each call `embed` once with
  `title\nsummary\nbody` and pass the vector to `applyAccepted`; `deprecate` never calls
  `embed` and passes `null`; a throwing embedder → `applyAccepted` receives `null` and
  `promote` still reports the item applied.

**DB-gated integration** (skipped unless `DATABASE_URL`; uses `StubEmbedder`)
- Schema: `vector` extension installed; `memory.embedding` is `vector(1024)`;
  `idx_memory_embedding_hnsw` exists.
- `recallSemantic` correctness (StubEmbedder is deterministic but NOT semantic → the test
  **controls vectors directly**): seed active rows, row A with `embedding = stubEmbed(<query>)`
  (cosine ≈ 1), row B with `embedding = stubEmbed(<unrelated>)`; assert `recallSemantic`
  returns A before B and honours `excludeIds` (a passed id never appears) and `k`.
- NULL-embedding exclusion: a row with `embedding IS NULL` is never returned by
  `recallSemantic` (but is still found by the unchanged BM25 `recall`).
- End-to-end two-phase: a query with `< N` BM25 matches surfaces a semantically-near (low-
  lexical-overlap) row appended after the BM25 rows; a query with `≥ N` BM25 matches returns
  BM25-only in the same order as a pure-recall baseline.

Run gate (project-map): `npm run build && npm test -- --run && npm run lint`.

## DEFERRED (explicit fence — NOT in this change)

- Real `BedrockEmbedder.invokeModel` (VPC PrivateLink + IAM + model access; out-of-band
  `pnpm add @aws-sdk/*`). Skeleton throws; callers fail-soft.
- Query-embedding cache (a later cost optimization — two-phase already bounds calls to
  weak-lexical first pages only).
- Backfill script for rows promoted before 0005 (`embedding IS NULL` → BM25-only, invisible
  to Phase 2 until re-embedded).
- `CREATE INDEX CONCURRENTLY` / live-table prod migration + the `rds_superuser` grant (ops).
- Paginating semantic hits (they are first-page-only extras); score-threshold trigger;
  weighted-score fusion / true RRF (the superseded fusion-always approach).
- HNSW query-time tuning (`hnsw.ef_search`, `hnsw.iterative_scan` for filtered NN) beyond
  pilot defaults.
- Invariants unchanged: no new runtime dependency; pnpm-only; ESM `.js`; parameterized +
  tenant-scoped SQL; `content_tsv` GENERATED-ALWAYS; error opacity; and — critically — the
  BM25 `recall` SQL, `RecallCursor` codec, and `RECALL_COUNT_SQL` are byte-for-byte UNCHANGED.
```
