# Design: Search explorer and revision history diff

## Technical Approach

Two independent slices, both read-only:

1. **Buscar como agente** — a project_admin REST read
   `GET /api/v1/projects/:projectId/search` that runs the **same** ranking code as MCP `recall`.
   Today the ranking lives inline in `recallHandler` (`src/mcp/tools/recall.ts`): two candidate
   queries (`PgMemoryRepository.recallLexicalCandidates` / `recallSemantic`) → `fuseRrf` →
   `prioritizeRepo`. We move exactly that block (plus the private `recallSemanticFailSoft`) into one
   exported function, `rankActiveMemories` in a new `src/search/hybridSearch.ts`, and make
   `recallHandler` call it. The REST route calls the same function. That gives one code path by
   construction, not by copy.
   Rank provenance comes from `fuseRrf` itself: while it accumulates the score it already knows
   each row's 1-based index in each list. It now records `lexicalRank` and `semanticRank` on
   every `FusedCandidate`. The score maths, the sort comparator and the tie-break do not change.
   `prioritizeRepo` already copies whole candidate objects, so the new fields come through
   unchanged. `recallHandler` still maps only `f.row`, so the MCP response is byte-identical.
2. **History diff**: built entirely in the web app. `GET …/memories/:memoryId` already returns
   `revisions[]` (newest first, at most 100) with title, summary, body, type and fields. The memory
   detail screen gets a `RevisionDiff` component. It lets the user pick two revisions (default:
   previous vs current). It diffs title, summary and body word by word with the existing
   `wordDiff` helper (from demo-ux-polish), and diffs `fields` key by key with a new pure helper.
   Everything renders as text nodes.

No migration, no new dependency, no change to the MCP contract, ranking, filters or limits.

## Architecture Decisions

### Decision: Extract the ranking block into `rankActiveMemories` (src/search/hybridSearch.ts)

**Choice**: New module `src/search/hybridSearch.ts`:

```ts
export interface SearchTenant { projectId: string; repoId: string | null } // declared in memoryRepository.ts
export interface HybridSearchDeps {
  memoryRepository: Pick<MemoryRepository, 'recallLexicalCandidates' | 'recallSemantic'>;
  embedder: Embedder;
}
export interface HybridSearchParams {
  query: string;
  scope: 'repo' | 'project';
  types?: MemoryType[];          // undefined = all types (callers normalize [] → undefined)
}
export interface HybridSearchResult {
  ranked: FusedCandidate<MemoryRow>[];   // fused, repo-prioritized when applicable
  semantic: 'ok' | 'unavailable';        // 'unavailable' only when embed() or recallSemantic threw
}
export async function rankActiveMemories(
  deps: HybridSearchDeps, tenant: SearchTenant, params: HybridSearchParams,
): Promise<HybridSearchResult>;
```

Body = today's `recallHandler` lines 57–67, moved verbatim:
- `Promise.all([recallLexicalCandidates(tenant, {query, scope, types}, RRF_CANDIDATES), semanticFailSoft(...)])`
- `fuseRrf(lexical, semantic)`
- `scope === 'project' && tenant.repoId !== null ? prioritizeRepo(fused, tenant.repoId) : fused`

`semanticFailSoft` returns `{ rows, ok }`. On a throw it keeps today's exact warning
(`[search] semantic side failed (<ErrorName>) — returning lexical-only`, error name only, never the
query) and returns `{ rows: [], ok: false }`. An empty semantic list that did not throw (for
example, no embeddings yet) counts as `'ok'`.

Guard: `scope === 'repo' && tenant.repoId === null` throws a plain `Error` (a programming error that
becomes an opaque 500). It never silently widens to project scope. The explorer always uses
`scope: 'project'`, and recall always has a repo.

`recallHandler` becomes:
`const { ranked } = await rankActiveMemories(deps, ctx.tenant, { query: input.query, scope, types });`
It ignores `semantic` and the provenance fields. The cursor, slicing, staged mix and response shape
stay unchanged.

**Alternatives considered**:
- *Keep the function in `recall.ts` and import it from the REST route.* This works (memoryRoutes
  already imports `mcp/tools/schemas.js`), but it makes the HTTP layer depend on an MCP tool
  handler file for domain logic. `src/search` is the module the project map assigns to "RRF of
  BM25 and pgvector candidates".
- *A second "explorer" search in the REST layer that calls the repository and `fuseRrf` itself.*
  Rejected: that forks the path the proposal forbids. Any later change to recall (for example, a
  new filter) would silently diverge.
- *A `SearchService` class wired into AppServices.* Rejected (YAGNI): it is one stateless function
  with two consumers, and the existing seams are already in AppServices.

**Rationale**: One function, two callers, zero behavioural change for recall. The parity test
becomes a guard against future forks rather than a reconciliation of two implementations.
**Reversible**: Yes. Inline the function back into `recallHandler` and delete the route.

### Decision: Rank provenance recorded inside `fuseRrf` (additive fields)

**Choice**: `FusedCandidate<T>` becomes

```ts
export interface FusedCandidate<T> {
  row: T;
  score: number;
  /** 1-based position in the lexical list; null when absent. */
  lexicalRank: number | null;
  /** 1-based position in the semantic list; null when absent (or semantic side unavailable). */
  semanticRank: number | null;
}
```

`fuseRrf` iterates the two lists as named passes (lexical, then semantic). On creation it sets the
rank for the list it is in and leaves the other as `null`. On accumulation it sets the second rank.
The score term (`1 / (k + index + 1)`), the accumulation order and the comparator stay as they
are. `prioritizeRepo` needs no change.

**Alternatives considered**:
- *A parallel `explainRrf(lexical, semantic)` that recomputes ranks.* Rejected: it duplicates the
  fusion loop and can drift from it.
- *Return the raw lexical and semantic lists from `rankActiveMemories` and derive ranks in the
  route.* Rejected: a second, implicit source of truth for "rank". The fusion step is the only
  place where rank is defined (1-based, k = 60).
- *Expose the BM25 or cosine raw scores.* Rejected: they are not selected today (the lexical
  `rank` column is ignored by `mapRow`). They would need SQL changes and are not needed to explain
  RRF, which uses ranks only.

**Rationale**: The two fields are already computed implicitly by `index + 1`. Recording them is
additive. Existing consumers (`recallHandler`, `scripts/eval.ts`, `tests/search/rrf.test.ts`) read
only `row` and `score`, or compare id lists, so nothing breaks.
**Reversible**: Yes. Remove two fields.

### Decision: Widen the candidate-query tenant parameter to `SearchTenant`

**Choice**: In `src/db/memoryRepository.ts`, declare
`export interface SearchTenant { projectId: string; repoId: string | null }` and type the first
parameter of `recallLexicalCandidates` and `recallSemantic` (interface and `PgMemoryRepository`)
as `SearchTenant`. The SQL is unchanged. `repoId` reaches SQL only when `scope === 'repo'`, which
it already does. `TenantContext` stays assignable, so recall call sites and existing fakes and
spies (which declare `tenant: TenantContext`, a method-parameter bivariance case) keep compiling.

**Alternatives considered**: Building a synthetic `TenantContext` in the route
(`repoId: ''`, `branch: ''`). Rejected: it lies about the tenant and hides a project-level search
behind a fake repo id.
**Rationale**: The project-level explorer has no repo or branch. The type should say so.
**Reversible**: Yes, type-only.

### Decision: Tenant scope of the explorer: project-wide, optional `repoId` boost validated against the project

**Choice**: The route searches the path's project with `scope: 'project'`.
- `repoId` absent → no repo boost (`SearchTenant.repoId = null`): pure fused order.
- `repoId` present → zod `uuid`, then
  `memoryAdminRepository.findProjectRepoId(projectId, repoId)`. That function already exists, and
  its SQL `WHERE project_id = $1 AND ($2 IS NULL OR id = $2)` returns `null` for a foreign or
  absent repo. A `null` result → uniform **404** (same as a foreign memory id). Otherwise the
  boost uses that repo, which reproduces exactly what an agent whose `X-Git-Remote` resolves to
  that repo gets from `recall` (scope project).
- The X-Git-Remote / X-Git-Branch headers are **not** read by `/api` (REST stays project-only, per
  `ProjectContext`).

To reach `findProjectRepoId`, `src/index.ts` hoists the existing `new PgMemoryAdminRepository(pool)`
into a const that is shared by `directMemoryService` and a new `AppServices.memoryAdminRepository`
field. `ApiRouterDeps` gets
`memoryAdminRepository: Pick<MemoryAdminRepository, 'findProjectRepoId'>`, plus `memoryRepository`
and `embedder`, which are already in AppServices. `createApp` passes `services` through as before.

**Alternatives considered**:
- *Default boost = the project's first repo.* Rejected: it is an arbitrary choice that is invisible
  to the user. "None" is honest, and the UI explains it.
- *Accepting a remote URL.* Rejected: it duplicates the tenant resolver and puts remote URLs in
  query strings and logs.
- *Skipping the existence check (the boost is harmless because candidates are project-scoped).*
  Rejected: secure-by-default says to validate untrusted input. A typo would also silently give the
  "no boost" order while the UI says otherwise.
- *A new `repoBelongsToProject` method on `MemoryRepository`.* Rejected: it adds a second query
  for something an existing method already answers.

**Rationale**: It reuses an existing, already-tested query and keeps the uniform 404 vocabulary.
The repo list for the selector comes from the existing `GET …/admin-summary`, the same
project_admin gate, so no new endpoint is needed.
**Reversible**: Yes.

### Decision: Validation, response and audit

**Choice**:
- zod (`.strict()`, unknown params → 400):
  ```ts
  export const SearchQuery = z.object({
    q: z.string().trim().min(1).max(200),
    types: z.string().max(200).optional()            // CSV: "decision,gotcha"
      .transform((s) => s === undefined ? undefined : [...new Set(s.split(','))])
      .pipe(z.array(z.enum(MEMORY_TYPES)).min(1).optional()),
    limit: z.coerce.number().int().min(1).max(8).default(5),
    repoId: z.string().uuid().optional(),
  }).strict();
  ```
  A repeated parameter (`?q=a&q=b`) reaches zod as an array → 400. `types=` (empty) → 400 (the web
  client omits empty values, as `buildQuery` already does).
- Order: `projectAdmin` (non-admin → 404 before validation) → zod (400) → repo check (404) →
  `rankActiveMemories` → `ranked.slice(0, limit)` → audit → 200 JSON. `Cache-Control: no-store`
  comes from the router.
- Only the first page: no cursor (the explorer shows what one `recall` call returns).
  `totalCandidates = ranked.length`, the same number as recall's `total_matches` without staged
  rows.
- Audit: new read action `memories.search` (not added to `API_UPDATE_ACTIONS`).
  `recordApi(actor, project, 'memories.search', { resultCount, queryHash })` with
  `queryHash = sha256Hex(q.trim().toLowerCase())`. That is the same normalisation as the MCP recall
  wrapper (`src/mcp/tools/index.ts`), so the same query from an agent and from the web produces the
  same `access_log.query_hash`. No new detail keys. The raw query and the repo id are never audited.
  Like every other REST read, it is audited after success (recall audits before; REST convention
  wins in `/api`).
- Errors: the existing `apiErrorHandler` vocabulary (400/401/404/429/500). An embedder failure is
  **not** an error: the response is 200 with `semantic: 'unavailable'`.

**Alternatives considered**: `types` as a repeated parameter (`types=a&types=b`). Rejected: it mixes
string and array shapes under Express 5's simple parser, and `buildQuery` would need array support.
CSV is one string with one zod path.
**Rationale**: It mirrors `MemoryListQuery` (trim, max 200) and recall's limits (default 5, max 8).
The hash matches recall exactly.
**Reversible**: Partial. The public query and DTO names become part of `/api/v1`. They are
additive, and only the web consumes them.

### Decision: DTO

```ts
// src/http/api/types.ts (mirrored by hand in packages/web/src/api/types.ts)
export interface SearchResultDto {
  /** 1-based position in the returned order (after repo priority). */
  position: number;
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  repoId: string | null;
  version: number;              // current_revision
  updatedAt: string;
  /** RRF fused score Σ 1/(60 + rank). */
  score: number;
  lexicalRank: number | null;   // 1..50 or null
  semanticRank: number | null;  // 1..50 or null
}
export interface SearchResponseDto {
  items: SearchResultDto[];
  totalCandidates: number;
  semantic: 'ok' | 'unavailable';
  /** Repo whose memories were prioritized; null = no boost. */
  repoId: string | null;
}
```

The DTO carries no body or fields. It identifies what recall would return, and the title links to
the existing memory detail. This keeps the response small and avoids a second content-rendering
surface. The repo slug is resolved in the web app from the admin-summary repos it already loaded
for the selector (no join added to the recall SQL).

### Decision: Web screen "Buscar como agente"

**Choice**: `packages/web/src/screens/SearchScreen.tsx`, hash route `#/search`
(`{ name: 'search' }`). The sidebar entry "Buscar como agente" goes after "Memoria del proyecto".
Structure:
- Form (submit-only; no search-as-you-type, so each audit row and embed call matches one
  deliberate query): `Consulta` text input (`maxLength=200`, required); `Tipos` multi-select pills
  (`aria-pressed`, using the existing type labels); `Resultados` select 1–8 (default 5);
  `Repositorio del agente` select: "Ninguno (sin prioridad de repositorio)" plus the admin-summary
  repos. If admin-summary fails, the select is disabled with a visible muted note (not swallowed),
  and search still works without a boost.
- Static explanation: "Mismo camino que `recall`: solo memorias activas; se excluyen sustituidas,
  retiradas y pendientes de revalidación, y los borradores en preparación de cada agente.
  Puntuación = Σ 1/(60 + rango)." Plus a hint that choosing the agent's repo reproduces its exact
  order.
- `semantic === 'unavailable'` → warning banner (`role="status"`): the embedder did not respond and
  the results are lexical only.
- Results table: `#` (position), Título (link to `#/memory/:id`), Tipo (Chip), Repositorio (slug
  or "—"), Puntuación (4 decimals), Rango léxico, Rango semántico ("—" when null). The repo-boost
  group is visible through the repo column, so no extra badge is needed.
- States: the existing `StateViews` (loading, empty "Sin resultados", error with `role="alert"`
  using `errorMessage`, which never echoes server text).
- All strings go in `labels.ts`. Text-only rendering. Styling uses existing tokens and classes
  (table, chip, card). Only minimal new CSS rules if needed, all using `var(--*)`.

### Decision: History diff in memory detail

**Choice**:
- `packages/web/src/lib/revisionDiff.ts` (pure, tested):
  - `defaultRevisionPair(revisions) → { from: number; to: number } | null`. Returns null when there
    are fewer than 2 revisions. Otherwise `from = revisions[1].revisionNo` and
    `to = revisions[0].revisionNo` (the list is newest first).
  - `diffFields(before, after) → FieldChange[]` with
    `FieldChange = { key: string; kind: 'added' | 'removed' | 'changed'; before: string | null; after: string | null }`.
    It takes the union of top-level keys, sorted, and only includes changed keys. Values are
    compared and displayed as `typeof v === 'string' ? v : JSON.stringify(v)`, so they are text
    only. Nested key order is not normalised: fields are written by our own code paths with a
    stable shape.
- `packages/web/src/components/RevisionDiff.tsx`: two labelled selects, "Desde la versión" and
  "Hasta la versión" (options = revision numbers with date). The default comes from
  `defaultRevisionPair`, and any order is allowed. Choosing the same revision on both sides shows
  "Selecciona dos versiones distintas". The component renders title, summary and body with
  `wordDiff` in the same two-column `compare` layout as `ProposalComparison`. A type change shows
  as one row. Fields show one row per changed key: the key, then removed and added text
  (word-diffed when both sides exist). If no field changed: "Sin cambios en campos". Whitespace
  and newlines collapse in the diff view (wordDiff tokenizes on whitespace). The full body stays
  in each revision's existing "Ver contenido" block.
- The component appears at the top of the existing "Historial de versiones" card. It is not
  rendered when there is only one revision.
- The private `Segments` renderer in `ProposalComparison.tsx` is now used in two places. It moves
  to `packages/web/src/components/DiffSegments.tsx` (exported `DiffSegments`) and is imported by
  both. This is the extraction the policy allows on the second real occurrence. Behaviour is
  unchanged.

**Alternatives considered**: A server-side diff endpoint. Rejected: the data is already on the
client, and a server diff would add API surface for presentation logic. A line-based diff for body.
Rejected: wordDiff already exists and is tested, and bodies are 2000 characters at most.
**Rationale**: Reuses the existing helper and layout, with no API change.
**Reversible**: Yes.

## Data Flow

```
MCP recall ─────────────┐                      Web "Buscar como agente"
recallHandler            │                      SearchScreen ─► api.search() ─► GET /api/v1/projects/:p/search
  (cursor, staged mix)   │                                                        │ apiAuth → projectAdmin (404)
        │                │                                                        │ zod SearchQuery (400)
        ▼                ▼                                                        │ repoId? findProjectRepoId (404)
   rankActiveMemories(deps, tenant, {query, scope, types})  ◄─────────────────────┘
        │  ├─ memoryRepository.recallLexicalCandidates (top 50, active, BM25+decay)
        │  ├─ embedder.embed → memoryRepository.recallSemantic (top 50)   [throw → semantic:'unavailable', warn]
        │  ├─ fuseRrf  → FusedCandidate{row, score, lexicalRank, semanticRank}
        │  └─ prioritizeRepo (project scope + repoId ≠ null)
        ▼
   recall: ranked.slice(offset, offset+limit).map(row)       route: ranked.slice(0, limit) → SearchResultDto[]
          (provenance ignored)                                      → recordApi('memories.search', {resultCount, queryHash})

Memory detail:  GET …/memories/:id (unchanged) → revisions[] → RevisionDiff(from, to)
                → wordDiff(title|summary|body), diffFields(fields) → text nodes
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `FusedCandidate` (adds `lexicalRank`, `semanticRank`) | type | `src/search/rrf.ts` | `src/search/hybridSearch.ts`, `src/http/api/searchRoutes.ts` |
| `SearchTenant` | type | `src/db/memoryRepository.ts` | `src/search/hybridSearch.ts`, `src/http/api/searchRoutes.ts` |
| `rankActiveMemories` / `HybridSearchResult` | func / type | `src/search/hybridSearch.ts` | `src/mcp/tools/recall.ts`, `src/http/api/searchRoutes.ts` |
| `ApiAction` `'memories.search'` | type | `src/mcp/context.ts` | `src/http/api/searchRoutes.ts`, `src/auth/auditLogger.ts` |
| `AppServices.memoryAdminRepository` | interface | `src/mcp/context.ts` | `src/index.ts`, `src/http/app.ts` (pass-through) |
| `ApiRouterDeps` (adds `memoryRepository`, `embedder`, `memoryAdminRepository`) | interface | `src/http/api/types.ts` | `src/http/api/router.ts`, `src/http/api/searchRoutes.ts` |
| `SearchResultDto` / `SearchResponseDto` | type | `src/http/api/types.ts` | `packages/web/src/api/types.ts` (mirror), `packages/web/src/api/client.ts` |
| `GET /api/v1/projects/:projectId/search` | endpoint | `src/http/api/searchRoutes.ts` | `packages/web/src/api/client.ts` |
| `DiffSegments` | func (component) | `packages/web/src/components/DiffSegments.tsx` | `packages/web/src/components/ProposalComparison.tsx`, `packages/web/src/components/RevisionDiff.tsx` |
| `defaultRevisionPair` / `diffFields` | func | `packages/web/src/lib/revisionDiff.ts` | `packages/web/src/components/RevisionDiff.tsx` |

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/search/rrf.ts` | Modify | `FusedCandidate` gains `lexicalRank` and `semanticRank`; `fuseRrf` records them (score and order untouched). |
| `src/search/hybridSearch.ts` | Create | `rankActiveMemories` + fail-soft semantic side (moved from recall.ts), returns `{ranked, semantic}`. |
| `src/mcp/tools/recall.ts` | Modify | Delegates ranking to `rankActiveMemories`; removes the moved private helper; header doc points to hybridSearch. |
| `src/db/memoryRepository.ts` | Modify | Declares `SearchTenant`; the candidate-query tenant parameter is widened (types only, SQL unchanged). |
| `src/http/api/searchRoutes.ts` | Create | `GET /search`: zod `SearchQuery`, repo check, DTO mapping, audit. |
| `src/http/api/router.ts` | Modify | Mounts `makeSearchRoutes(deps)` on the projectAdmin router; header chain doc. |
| `src/http/api/types.ts` | Modify | `SearchResultDto`, `SearchResponseDto`; `ApiRouterDeps` gains `memoryRepository`, `embedder`, `memoryAdminRepository`. |
| `src/mcp/context.ts` | Modify | `ApiAction` gains `'memories.search'`; `AppServices` gains `memoryAdminRepository`. |
| `src/index.ts` | Modify | Hoists one `PgMemoryAdminRepository` shared by `directMemoryService` and `AppServices`. |
| `tests/search/rrf.test.ts` | Modify | Provenance cases. |
| `tests/search/hybridSearch.test.ts` | Create | Core function: order equals the previous inline logic, semantic flag, guard, no-boost path. |
| `tests/mcp/recallRrf.test.ts` | Modify | Only if a spy needs the widened type; all existing order assertions stay green unchanged. |
| `tests/http/api/searchRoutes.test.ts` | Create | Gates, validation, repo check, audit, DTO, parity with `recallHandler`. |
| `tests/http/api/helpers.ts` | Modify | Builds `memoryRepository` (InMemoryMemoryRepository), `embedder` and `memoryAdminRepository` fakes in `ApiRouterDeps`. |
| `tests/auth/fakes.ts` | Modify | `AppServices` stub gains `memoryAdminRepository`. |
| `tests/auth/auditLogger.test.ts` | Modify | `memories.search` is recorded as a read with `query_hash`. |
| `tests/db/searchExplorer.integration.test.ts` | Create | DB-gated parity: real SQL + StubEmbedder, explorer vs recall. |
| `packages/web/src/api/types.ts` | Modify | Mirror of the search DTOs. |
| `packages/web/src/api/client.ts` | Modify | `search(p, {q, types?, limit?, repoId?})` (types joined by `,`). |
| `packages/web/src/api/client.test.ts` | Modify | Search query-string building. |
| `packages/web/src/lib/hashRoute.ts` | Modify | `{ name: 'search' }` ↔ `#/search`. |
| `packages/web/src/lib/hashRoute.test.ts` | Modify | Search route parse/build. |
| `packages/web/src/lib/labels.ts` | Modify | Explorer and history-diff Spanish strings. |
| `packages/web/src/screens/SearchScreen.tsx` | Create | Explorer screen. |
| `packages/web/src/App.tsx` | Modify | Renders `SearchScreen` for the search route. |
| `packages/web/src/components/Sidebar.tsx` | Modify | "Buscar como agente" entry and section. |
| `packages/web/src/lib/revisionDiff.ts` | Create | `defaultRevisionPair`, `diffFields`. |
| `packages/web/src/lib/revisionDiff.test.ts` | Create | Helper tests. |
| `packages/web/src/components/DiffSegments.tsx` | Create | Shared text-only segment renderer (moved from ProposalComparison). |
| `packages/web/src/components/ProposalComparison.tsx` | Modify | Imports `DiffSegments` instead of its private copy. |
| `packages/web/src/components/RevisionDiff.tsx` | Create | Two-revision picker + diff. |
| `packages/web/src/screens/MemoryDetailScreen.tsx` | Modify | Mounts `RevisionDiff` in the history card. |
| `packages/web/src/styles.css` | Modify | Minimal rules for the explorer form, rank columns and diff selector (tokens only). |

Sequencing: `governance-insights` lands first and edits `router.ts`, `types.ts`, `context.ts`
(`ApiAction`), `auditLogger`, `App.tsx`, `Sidebar.tsx`, `hashRoute.ts` and `labels.ts`. This change
rebases additively on top of it. `demo-ux-polish` must have landed `wordDiff.ts` and
`ProposalComparison.tsx` before the `DiffSegments` move.

## New Modules

None

## Test Strategy

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| `fuseRrf` provenance | unit | Row in both lists gets both 1-based ranks; lexical-only row has `semanticRank: null` and the reverse; spec scenario A gets lexical 1 and semantic 3; score values and order are identical to before (existing assertions untouched); `prioritizeRepo` preserves ranks | `tests/search/rrf.test.ts` |
| `rankActiveMemories` | unit | Embedder throws → `semantic:'unavailable'`, lexical order, exactly one warning with the error name only; `recallSemantic` throws → same; empty semantic list → `'ok'`; `repoId: null` + project scope → pure fused order (no partition); repo scope with null repoId throws | `InMemoryMemoryRepository` from `tests/memory/fakes.ts`, `vi.spyOn(logger,'warn')` |
| recall regression | unit | The whole existing `recallRrf`, `recall`, `recall.pagination` and `getContext` suites pass unchanged (order, limits, cursor, staged mix, candidate parameters) | Proves "no ranking change" |
| `GET /search` gates and validation | unit (supertest) | 401 without credentials; contributor/viewer/foreign project → 404 before validation; 400 for missing q, whitespace-only q, q of 201 chars, limit 0/9/`abc`, unknown type, `types=`, repeated q, unknown param, malformed repoId; well-formed foreign repoId → 404; `Cache-Control: no-store` | `tests/http/api/helpers.ts` app |
| `GET /search` behaviour | unit (supertest) | Default limit 5, max 8; superseded, deprecated and pending memories are never returned; DTO has score and ranks matching `fuseRrf`; embedder down → 200 with `semantic:'unavailable'`; audit `memories.search` with `resultCount` and `queryHash === sha256Hex(q.trim().toLowerCase())`, and the raw q never appears in any audit argument | FakeEmbedder that can throw |
| **Parity** explorer == recall | unit + DB integration | Same fixture and query: `recallHandler(ctx{repoId:R}, scope project, no staged)` result ids (via `decodeHandle`) equal the `/search?repoId=R` item ids in order, for limit 5 and 8 and with a types filter. A two-repo fixture proves the boost matches. The DB variant uses `PgMemoryRepository` + `StubEmbedder` on seeded rows and calls `recallHandler` and the route on the same pool | `tests/http/api/searchRoutes.test.ts`, `tests/db/searchExplorer.integration.test.ts` (gated by `DATABASE_URL`) |
| auditLogger | unit | `memories.search` is a read action; queryHash goes to the `query_hash` column, not to detail | existing test file |
| `revisionDiff` helpers | unit | Fewer than 2 revisions → null; default pair = [1] vs [0]; `diffFields` for added, removed and changed keys, non-string values stringified, unchanged keys omitted, keys sorted | `packages/web/src/lib/revisionDiff.test.ts` |
| hashRoute / client | unit | `#/search` round-trip; the search URL omits empty params and joins types with `,` | existing web test files |
| Web security | unit | Existing `security.test.ts` / ESLint ban on `innerHTML` and `dangerouslySetInnerHTML` covers the new screen and components | no change |
