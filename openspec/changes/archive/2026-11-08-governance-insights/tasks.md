# Tasks: Governance insights — dashboard, activity and staging views

> Derived from design.md (§ File Changes, § Test Strategy). Orchestrator decisions: (1) keep the MODIFIED requirement fixing the quarantine footer to "falsos positivos"; (2) Inicio (`#/home`) becomes the default landing route (empty/unknown hash → home; update hashRoute tests); (3) the out-of-list edits in the design are accepted. Lands before search-explorer-and-history.

## Phase 1: Data layer (TDD)
- [x] 1.1 `src/db/insightsMapping.ts` + `tests/db/insightsMapping.test.ts` (rates, null denominators, FP incl. judge restores, action/actor mapping, unknown → other, facts allow-list, cursor bounds).
- [x] 1.2 `src/db/insightsRepository.ts` (`PgInsightsRepository`: dashboard aggregates, activity keyset UNION with project-scoped target joins, staging sessions + capped items, `maskPii` on staging titles) + DB-gated `tests/db/insightsRepository.integration.test.ts`.

## Phase 2: Endpoints
- [x] 2.1 `src/mcp/context.ts` (3 read actions, `AppServices.insightsRepository`), `src/http/api/types.ts` (DTOs, deps), `src/index.ts` wiring.
- [x] 2.2 `src/http/api/insightsRoutes.ts` (strict zod; audit after success) mounted in the projectAdmin chain (`router.ts`).
- [x] 2.3 `tests/http/api/insights.test.ts` + `tests/http/api/helpers.ts` (FakeInsightsRepository) + `tests/auth/fakes.ts`.

## Phase 3: Web
- [x] 3.1 `packages/web/src/api/{types,client}.ts` (+ client test); `lib/hashRoute.ts` routes home/activity/staging, default route home (+ tests); `lib/labels.ts` maps + metric definitions + quarantine footer fix; `lib/insights.ts` (+ test).
- [x] 3.2 `components/StatBar.tsx`; screens `HomeScreen.tsx`, `ActivityScreen.tsx`, `StagingScreen.tsx` (manual refresh); `Sidebar.tsx` entries (Inicio first); `App.tsx` cases; `styles.css` `/* insights */` section with tokens.
- [x] 3.3 `scripts/screenshots.ts` captures `#/home`, `#/activity`, `#/staging`; `docs/demo/INSTRUCTIVO.md` section (views + live FP/FN definitions and what is not measurable).

## Phase 4: Verify remediation (round 1)
- [x] 4.1 (security MEDIUM) `migrations/0011_access_log_activity_indexes.sql` (idempotent, header comment): `CREATE INDEX IF NOT EXISTS ... ON access_log (project_id, id DESC) WHERE action <> 'read'` and `... ON access_log (id DESC) WHERE project_id IS NULL AND actor_kind = 'system' AND action = 'admin'` (verify column names/enum literals against migrations); add to the migration ledger/tests the project uses for numbered migrations; update design.md index note.
- [x] 4.2 (security MEDIUM) `getDashboard`: run the aggregate queries sequentially (no 6-connection burst); keep results identical (tests unchanged).
- [x] 4.3 (reviewer MEDIUM) Inicio: judge-indicators card first (full width, above the grid) so it is visible at 1440×900; give `insights__indicators` a rule or remove it; regenerate `6-inicio.png` only if the stack is up (otherwise leave for the orchestrator).
- [x] 4.4 (reviewer MEDIUM) design.md: default route is Inicio (`#/home`); integration tests: `quarantine.restore` audit row pointing at another project's quarantine → `target: null`; unknown job / unknown api → `other` through SQL; job row with non-object `detail.detail` ignored.
- [x] 4.5 (LOW) Activity feed: `maskPii` on quarantine titles; repo label = slug, or remote_url with userinfo stripped (host/path only); cap `branch` fact to 200 chars; comment that `validating` sessions are in neither tab; limits parsed from digit-only strings (reject `1e1`, `0x10`) + repeated `limit` → 400 test.
