# Tasks: web-api-and-review-queue (C2)

> spec ↔ design reconciled (web-api, promotion, auth, http-security deltas ↔ design batches A–H). Starts after C1 lands (batches C and D modify C1 files). TDD per task. File lists: design.md § File Changes.

## Phase 1: Contracts
- [x] 1.1 (A) Contracts, errors, config: `src/mcp/context.ts`, `src/errors/appError.ts`, `src/http/api/types.ts`, `src/config/index.ts`; tests `tests/config/webConfig.test.ts`, `tests/config/rateLimitGuard.test.ts` [declares:ApiContracts]

## Phase 2: Auth and DB (parallel B, C)
- [x] 2.1 (B) Auth + seed: `src/db/authRepository.ts`, `src/auth/devAuthenticator.ts`, `src/auth/authorizer.ts`, `src/auth/auditLogger.ts`, `migrations/seed.dev.sql`, `tests/auth/fakes.ts`; tests `tests/auth/devAuthenticator.test.ts`, `tests/auth/authorizer.test.ts`, `tests/auth/authorizeProjectAdmin.test.ts`, `tests/auth/auditLogger.test.ts`, `tests/db/authRepository.integration.test.ts` [consumes:ApiContracts] [declares:AuthV2]
- [x] 2.2 (C) DB layer: `src/db/promotionRepository.ts` (txn cores, guards, approve/reject/abandon), `src/db/reviewQueueRepository.ts`, `tests/promote/fakes.ts`; tests `tests/db/review.integration.test.ts`, `tests/db/reviewQueue.integration.test.ts`, `tests/db/promotion.integration.test.ts` [consumes:ApiContracts] [declares:ReviewRepos]

## Phase 3: Services (parallel D, E)
- [x] 3.1 (D) Review service: `src/review/reviewService.ts`, `src/embedder/embedder.ts`, `src/promote/promoteService.ts`; tests `tests/review/fakes.ts`, `tests/review/reviewService.test.ts`, `tests/embedder/failSoft.test.ts` [consumes:ReviewRepos] [declares:ReviewService]
- [x] 3.2 (E) `/promote` closed_unmerged: `src/auth/oidcAuthenticator.ts`, `src/auth/devOidcAuthenticator.ts`, `src/http/promote.ts`, `.github/workflows/promote.yml`; tests `tests/http/promote.test.ts`, `tests/auth/oidc.test.ts` [consumes:AuthV2] [consumes:ReviewRepos]

## Phase 4: HTTP
- [x] 4.1 (F) Routers + static: `src/http/api/errorHandler.ts`, `src/http/api/apiAuth.ts`, `src/http/api/projectAdmin.ts`, `src/http/api/meRoutes.ts`, `src/http/api/reviewRoutes.ts`, `src/http/api/router.ts`, `src/http/static.ts`; tests under `tests/http/api/` and `tests/http/static.test.ts` [consumes:AuthV2] [consumes:ReviewService]

## Phase 5: Composition + docs (parallel G, H)
- [x] 5.1 (G) `src/mcp/context.ts` (reviewService), `src/http/app.ts`, `src/index.ts`, `tests/auth/fakes.ts`, `tests/http/security.test.ts`, `tests/http/app.routes.test.ts`, `scripts/smoke.ts` (`/api/v1/me` as tl)
- [x] 5.2 (H) `README.md`, `DEVELOPMENT.md`

## Phase 6: Gate
- [x] 6.1 Full suite + DB gate, lint, build, compose from scratch, `pnpm smoke` ×2, manual API walk (me as tl/viewer, queue list/detail, approve, reject) against compose

## Phase 7: Verify remediation

- [x] 7.1 Round-1 fixes: R1-CR M1 (no-store on 429), M3 (smoke covers the API walk), L1-L4; SEC: JSON content-type on POSTs, archived projects, static SVG CSP + case-insensitive NOT_SPA, PERSIST_MASKED reviewed_at guard
