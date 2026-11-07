# Tasks — promotion-pipeline (local-testable vertical)

schema: tasks-v1
change: promotion-pipeline
status: READY
date: 2026-07-30

Each task maps to REQ ids + design.md's File Changes table. Batch letters mark file-independence
for parallel apply workers. Dependencies flow A→B→C→D→E→F→G.

## Batch A — leaf seams (independent files, parallel)
- [x] **T001** Create `src/judge/judge.ts` — `Judge` interface + `Verdict`/`JudgeItem` types. [REQ-11]
- [x] **T002** Create `src/judge/deterministicJudge.ts` — config-verdict stub (DEV/TEST). [REQ-11]
- [x] **T003** Create `src/judge/bedrockJudge.ts` — fail-closed wrapper; DEFERRED `invokeModel` throw; catch→uncertain; NO aws-sdk import. [REQ-11]
- [x] **T004** Create `src/auth/oidcAuthenticator.ts` — `OidcVerifier` + `PromotePrincipal` + `GithubOidcAuthenticator` fail-closed skeleton. [REQ-13]
- [x] **T005** Create `src/auth/devOidcAuthenticator.ts` — `DevOidcAuthenticator` + `DEV_PROMOTE_PRINCIPAL`. [REQ-13]
- [x] **T006** Modify `src/config/index.ts` — 5 new guarded env vars + 4 superRefine prod guards (transform, not coerce). [REQ-21]

## Batch B — context widening + auth/authRepo methods (shared interfaces; one worker, sequential)
- [x] **T007** Modify `src/mcp/context.ts` — `ToolName += 'promote'`; `Authorizer.authorizePromote`;
  `AuditLogger.recordPromote`; widen `AppServices` (promotionRepository, judge, oidcVerifier,
  authRepository, promoteService). Imports for PromotePrincipal/PromotionRepository/Judge/OidcVerifier. [REQ-14,18]
- [x] **T008** Modify `src/db/authRepository.ts` — `findRepoByGithubSlug(ownerRepo)` (canonical remote_url lookup) + `findActiveMachineCredential(projectId, principalName)`. [REQ-14,15]
- [x] **T009** Modify `src/auth/authorizer.ts` — `RdsAuthorizer.authorizePromote` (machine_credential path; opaque deny). [REQ-14]
- [x] **T010** Modify `src/auth/auditLogger.ts` — `RdsAuditLogger.recordPromote` (ci/promote; no raw content). [REQ-18]

## Batch C — promotion repository (after B; own file)
- [x] **T011** Create `src/db/promotionRepository.ts` — `PromotionRepository` + `PgPromotionRepository`:
  findOpenSessionId, fetchPromotableItems, recordVerdict, applyAccepted (4 ops, per-item txn, FOR UPDATE,
  stale check, ON CONFLICT dedup, content_tsv omitted, first-writer-wins marker), quarantineItem (redact
  on secret path), finalizeSession. Exact SQL from design.md. [REQ-01..10]

## Batch D — orchestration (after C; own file)
- [x] **T012** Create `src/promote/promoteService.ts` — `PromoteService.promote(sessionId, meta)`
  state machine (sanitize→judge/reuse→apply|quarantine|leave-uncertain→finalize→recordPromote);
  fail-closed; idempotent. [REQ-19,20]

## Batch E — endpoint + wiring (after D; parallel where files disjoint)
- [x] **T013** Create `src/http/promote.ts` — `makePromoteHandler(services)`: zod body (.strict), OIDC
  verify → claim==body.repo → findRepoByGithubSlug → authorizePromote → findOpenSessionId → promote →
  200 outcome; try/catch → next(err) opacity. [REQ-16,17]
- [x] **T014** Modify `src/http/app.ts` — wire `app.post('/promote', makePromoteHandler(services))` before terminal handler. [REQ-16]
- [x] **T015** Modify `src/index.ts` — construct promotionRepository/judge/oidcVerifier/promoteService
  (config-guarded + NODE_ENV!=='production' defense-in-depth) + widen services bag. [REQ-21]
- [x] **T016** Modify `migrations/seed.dev.sql` — dev machine_credential + open `main` session + one pending `add` item (idempotent). [REQ-26]

## Batch F — tests (after E; independent files, high parallelism)
- [x] **T017** Create `tests/judge/deterministicJudge.test.ts` + `tests/judge/bedrockJudge.test.ts` (fail-closed). [REQ-22]
- [x] **T018** Create `tests/promote/promoteService.test.ts` — full state machine over fakes (accepted/rejected/uncertain/stale/duplicate/secret/terminal/no_op/fail-closed). [REQ-22]
- [x] **T019** Create `tests/config/promoteConfig.test.ts` — guard matrix (prod-forbidden stubs, required-when-off, transform false). [REQ-22]
- [x] **T020** Create `tests/auth/oidc.test.ts` — DevOidcAuthenticator returns principal; GithubOidcAuthenticator throws PERMISSION_DENIED. [REQ-22]
- [x] **T021** Create `tests/db/promotion.integration.test.ts` (DB-gated) — 4 ops, dedup, stale, supersede relation idempotency, quarantine, terminal, idempotent re-run. [REQ-23]
- [x] **T022** Create `tests/http/promote.test.ts` (supertest) — dev stubs: seeded session→promoted; claim mismatch→deny; no session→no_op; unknown repo→deny; opaque 500. [REQ-24]
- [x] **T023** Modify auth fakes (`tests/auth/fakes.ts`) — done by Batch B core worker (AppServices widened) — add stub authorizePromote/recordPromote/findRepoByGithubSlug/findActiveMachineCredential + a fake PromotionRepository/Judge/OidcVerifier where needed so existing tests + new ones compile. [REQ-22,25]

## Batch G — gate (after F; single sequential)
- [x] **T024** Run `pnpm build && pnpm test -- --run && pnpm lint` — all green; existing 285 stay passing. [REQ-25]

## Notes
- Scope fence (REQ-27): NO real Bedrock/aws-sdk, NO real OIDC JWKS, NO API Gateway/Action YAML, NO
  sweep/retention, NO 3-way merge, NO Web UI, NO new migration. Skeletons + stubs + dev seed only.
- B is the atomic interface batch (context.ts must precede the impls that satisfy it).
