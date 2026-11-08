# Tasks: Search explorer and revision history diff

> Derived from design.md (§ File Changes, § Test Strategy). Lands AFTER governance-insights (shared router/types/App/Sidebar/labels) and after demo-ux-polish (wordDiff, ProposalComparison). Decisions: audit action `memories.search`; project_admin only; repo selector reuses `admin-summary`.

## Phase 1: Search core (TDD, no ranking change)
- [x] 1.1 `tests/search/rrf.test.ts` provenance cases; `src/search/rrf.ts`: `FusedCandidate.lexicalRank/semanticRank` (1-based, null when absent), score/order untouched.
- [x] 1.2 `src/db/memoryRepository.ts`: `SearchTenant {projectId, repoId: string|null}` (types only, SQL unchanged).
- [x] 1.3 `src/search/hybridSearch.ts` `rankActiveMemories(deps, tenant, {query, scope, types}) → {ranked, semantic}` (ranking block moved verbatim from recall.ts; repo-scoped with null repo → internal error) + `tests/search/hybridSearch.test.ts`.
- [x] 1.4 `src/mcp/tools/recall.ts` delegates to `rankActiveMemories`; all existing recall suites green unchanged.

## Phase 2: Endpoint
- [x] 2.1 `src/mcp/context.ts` (`ApiAction` `'memories.search'`, `AppServices.memoryAdminRepository`), `src/http/api/types.ts` (DTOs, `ApiRouterDeps` additions), `src/index.ts` (hoist one `PgMemoryAdminRepository`).
- [x] 2.2 `src/http/api/searchRoutes.ts` (zod strict query: q trimmed 1..200, types csv subset dedup, limit 1..8 default 5, repoId uuid optional → `findProjectRepoId` or 404; DTO; audit read with query hash) mounted on the projectAdmin router.
- [x] 2.3 Tests: `tests/http/api/searchRoutes.test.ts` (gates, validation, repo check, audit, DTO, parity with recallHandler), helpers/fakes updates, `tests/auth/auditLogger.test.ts`, DB-gated `tests/db/searchExplorer.integration.test.ts` (real SQL + StubEmbedder parity).

## Phase 3: Web
- [x] 3.1 `packages/web/src/api/{types,client}.ts` (+ client test), `lib/hashRoute.ts` (+ test) `#/search`, `lib/labels.ts` strings.
- [x] 3.2 `screens/SearchScreen.tsx` (submit-only, repo selector from admin-summary with disabled fallback, rank columns "—", lexical-only notice) + `App.tsx` + `Sidebar.tsx` "Buscar como agente".
- [x] 3.3 `components/DiffSegments.tsx` (moved from ProposalComparison), `lib/revisionDiff.ts` (+ test), `components/RevisionDiff.tsx` mounted in `screens/MemoryDetailScreen.tsx`; styles with tokens only.
- [x] 3.4 Docs: INSTRUCTIVO (explorer + history diff; HU-08/HU-11 table rows), facade contract note only if recall contract text changes (it should not).

## Phase 4: Integration (end of the C10–C13 batch)
- [x] 4.1 `scripts/screenshots.ts`: wait for each screen's loaded state (no "Cargando…" text / a content selector visible) before capturing; add `9-buscar-como-agente.png` and a memory-detail capture showing the history diff (`10-historial-de-versiones.png`) if a memory with ≥2 revisions exists in the seed.
- [x] 4.2 Fresh stack (`pnpm demo:reset`), `pnpm demo`, `pnpm smoke`, then exercise `pnpm demo:promote -- --branch main` (expect no_op or an outcome, exit 0) and `pnpm demo:promote -- --branch feature/x` without `--pr` (expect usage error, exit 1); regenerate all screenshots and open at least Inicio, review detail and the explorer to confirm they are not in a loading/empty-error state.

## Phase 5: Verify remediation (round 1)
- [x] 5.1 (reviewer MEDIUM) `tests/search/hybridSearch.test.ts`: spy on `recallLexicalCandidates`/`recallSemantic` and assert exact arguments (limit 50, `excludeIds: []`, scope/types forwarded, `scope:'repo'` receives the tenant repo); keep the existing cases.
- [x] 5.2 (reviewer MEDIUM) `scripts/screenshots.ts`: fail a capture when `main [role="alert"]` is present; distinct marker for the search results region (e.g. `data-state` on results/empty-results) instead of matching the pre-search Empty view; catch per screen so one failure does not abort the rest (exit non-zero at the end if any failed).
- [x] 5.3 (LOW) `[search]` log prefix in hybridSearch (check no test asserts the old text); sr-only "(añadido)/(eliminado)" on RevisionDiff field marks and move those strings to `labels.ts`; scope `.num` CSS to the search table; whitespace-only query hint; fix the misleading `findProjectRepoId` doc comment.
- [x] 5.4 Clean captures for the docs: `pnpm demo:reset` then `pnpm screenshots` ONLY (no demo/smoke before, so captures show seed data); afterwards run `pnpm demo` and `pnpm smoke` to confirm they still pass.
