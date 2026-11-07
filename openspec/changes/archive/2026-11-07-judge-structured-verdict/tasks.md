# Tasks: judge-structured-verdict (C1)

> spec ↔ design reconciled. `specs/promotion` maps to design sections Routing R1–R8, Sanitize S1–S4, Notifier, Config. `specs/staging` maps to D3 (remember). `specs/dev-harness` maps to E (compose).
> TDD: within each task, write or adjust the tests first (RED), then the code (GREEN). File lists follow design.md § File Changes.

## Phase 1: Foundations (parallel: A, B, C)

- [x] 1.1 (A) Migration `migrations/0007_judge_structured_verdict.sql` + DB repositories: `src/db/promotionRepository.ts` (single `Verdict` import, extended row/fetch with `reviewed_at IS NULL`, `findJudgeContext`, `persistMasked`, `recordDecision`, new `quarantineItem` signature with fields blanked on redact), `src/db/stagingRepository.ts` (new insert params); tests `tests/db/judgeVerdict.migrate.integration.test.ts`, `tests/db/promotion.integration.test.ts`, `tests/db/stagingRepository.integration.test.ts` [declares:PromotionRepositoryV2]
- [x] 1.2 (B) Judge contract and implementations: `src/judge/judge.ts` (types, `ALLOWED_PAIRS`, `failClosed`, `normalizeJudgeResult`), `src/judge/deterministicJudge.ts` (rules 1–7), `src/judge/bedrockJudge.ts` (JSON + zod, XML escape, related-id filter); tests `tests/judge/judgeResult.test.ts`, `tests/judge/deterministicJudge.test.ts`, `tests/judge/bedrockJudge.invoke.test.ts`, `tests/judge/bedrockJudge.test.ts` [declares:JudgeResult]
- [x] 1.3 (C) Detectors: `src/security/injectionScan.ts`, `src/security/piiMask.ts`, `src/security/hash.ts` (`computeContentHash`); tests `tests/security/injectionScan.test.ts`, `tests/security/piiMask.test.ts`, `tests/security/contentHash.test.ts` [declares:Detectors]

## Phase 2: Seams (D1)

- [x] 2.1 Notifier, config, context: `src/notify/notifier.ts`, `src/config/index.ts` (+`JUDGE_CONFIDENCE_THRESHOLD`, `MANDATORY_REVIEW_TYPES`, `JUDGE_STUB_CONFIDENCE`, −`JUDGE_STUB_VERDICT`), `src/mcp/context.ts`, `tests/auth/fakes.ts`; tests `tests/notify/notifier.test.ts`, `tests/config/judgeConfig.test.ts` [consumes:JudgeResult] [declares:Notifier]

## Phase 3: Pipeline and capture (parallel: D2, D3, E)

- [x] 3.1 (D2) Promotion flow: `src/promote/sanitize.ts`, `src/promote/routing.ts`, `src/promote/promoteService.ts`, `src/index.ts`; shared fakes `tests/promote/fakes.ts`; tests `tests/promote/promoteVerdict.test.ts`, `tests/promote/sanitize.test.ts`, `tests/promote/routing.test.ts`, `tests/promote/promoteService.test.ts`, `tests/promote/promoteEmbedding.test.ts`, `tests/http/promote.test.ts` [consumes:PromotionRepositoryV2] [consumes:JudgeResult] [consumes:Detectors] [consumes:Notifier]
- [x] 3.2 (D3) Capture: `src/mcp/tools/remember.ts` (`computeContentHash`, stale → `stale_target` + `mandatory_review` + notify once); tests `tests/staging/remember.test.ts`, `tests/staging/fakes.ts` [consumes:Notifier] [consumes:Detectors]
- [x] 3.3 (E) Compose/docs: `docker-compose.yml` (drop `JUDGE_STUB_VERDICT`), `README.md` config table, `DEVELOPMENT.md` wording, `openspec/specs/dev-harness/spec.md` references are synced at archive (no edit here)

## Phase 4: Gate

- [x] 4.1 Full suite (unit + DB gate against compose on 5433), lint, build, `docker compose down -v && up --build`, `pnpm smoke` ×2; DeterministicJudge demo triggers exercised end-to-end through `/promote` (one item per outcome) and reported

## Phase 5: Verify remediation

- [x] 5.1 Round-1 fixes: SEC M-1/M-2/M-3, reviewer M1/M2, SEC L-1/L-2/L-3/L-4/L-7/L-9, reviewer LOW-1/LOW-3 (see verify-report)
