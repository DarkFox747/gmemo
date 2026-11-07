# Apply Progress — promotion-pipeline

schema: apply-progress-v1
change: promotion-pipeline
updated: 2026-07-30

## Batch A — leaf seams ✅
Workers: 3 parallel. Status: SUCCESS. Gate: build + lint + 285 tests green.
- [x] T001 src/judge/judge.ts (Judge/Verdict/JudgeItem)
- [x] T002 src/judge/deterministicJudge.ts (config-verdict stub)
- [x] T003 src/judge/bedrockJudge.ts (fail-closed; DEFERRED invokeModel; no aws-sdk)
- [x] T004 src/auth/oidcAuthenticator.ts (OidcVerifier + PromotePrincipal + GithubOidcAuthenticator fail-closed)
- [x] T005 src/auth/devOidcAuthenticator.ts (DevOidcAuthenticator + DEV_PROMOTE_PRINCIPAL)
- [x] T006 src/config/index.ts (5 guarded env + 4 superRefine prod guards)
Deviations: worker A3 added JUDGE_STUB='true' + PROMOTE_OIDC_DEV_BYPASS='true' to tests/config/prodGuard.test.ts
fixture (b) (same pattern as AUTH_DEV_BYPASS). TODO Batch E: add both vars to .env.dev.example so docker compose still boots.

## Batch B — core (context + auth + repo + service + index) ✅
Worker: 1 (sequential; one atomic build unit). Status: SUCCESS. Gate: build + lint + 285 tests green.
- [x] T007 context.ts (ToolName+='promote'; Authorizer.authorizePromote; AuditLogger.recordPromote; AppServices +5 fields)
- [x] T008 authRepository.ts (findRepoByGithubSlug + findActiveMachineCredential)
- [x] T009 authorizer.ts (RdsAuthorizer.authorizePromote — machine path, opaque)
- [x] T010 auditLogger.ts (recordPromote; actorKind 'ci'/action 'promote' already in 0001 enums)
- [x] T011 promotionRepository.ts (PgPromotionRepository: 4 ops per-item txn, FOR UPDATE, dedup, content_tsv omitted, quarantine, finalizeSession)
- [x] T012 promoteService.ts (orchestration state machine, fail-closed, idempotent)
- [x] T015 index.ts (construct judge/oidc/promotionRepo/promoteService config-guarded + widen services)
- test fakes updated (tests/auth/fakes.ts) to satisfy widened AppServices
Deviation: ApplyContext gained a `sessionId` field (needed for quarantine origin_session_id) — minor extension of the design interface.

## Batch E — endpoint + seed ✅
Workers: 2 parallel. Status: SUCCESS. Gate: build + lint + 285 tests green.
- [x] T013 src/http/promote.ts (makePromoteHandler 9-step chain; opacity like makeMcpPostHandler)
- [x] T014 src/http/app.ts (wire POST /promote before terminal handler)
- [x] T016 migrations/seed.dev.sql (machine_credential + open main session + pending add item) + .env.dev.example (JUDGE_STUB/JUDGE_STUB_VERDICT/PROMOTE_OIDC_DEV_BYPASS)
- [x] T023 tests/auth/fakes.ts (already satisfied by Batch B core widening)
Note: seed UUIDs matched design exactly; existing repo remote_url already canonicalizes for findRepoByGithubSlug.

## Batch F — tests ✅
Workers: 5 parallel. Status: SUCCESS.
- [x] T017 tests/judge/{deterministicJudge,bedrockJudge}.test.ts (fail-closed load-bearing test)
- [x] T018 tests/promote/promoteService.test.ts (32 tests — full state machine)
- [x] T019 tests/config/promoteConfig.test.ts (guard matrix)
- [x] T020 tests/auth/oidc.test.ts (dev principal; github fail-closed)
- [x] T021 tests/db/promotion.integration.test.ts (DB-gated; 17 tests, all 4 ops + dedup + stale + relation idempotency + quarantine + terminal + idempotent)
- [x] T022 tests/http/promote.test.ts (supertest; happy/mismatch/no_op/unknown-repo/malformed/fault opacity)

## Batch G — consolidated gate ✅
- [x] T024 build clean; 358 tests passed, 83 DB-gated skipped, 0 failed; lint clean.

## APPLY COMPLETE — 24/24. Ready for verify.
