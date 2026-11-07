# Apply Progress: judge-structured-verdict

## Batch 1 — 2026-11-07 (3 parallel workers: A sonnet, B opus, C sonnet-high)

### Completed
- [1.1] Migration 0007 + promotionRepository V2 (`findJudgeContext`, `persistMasked`, `recordDecision`, `quarantineItem(QuarantineInput)`, redact blanks `fields`) + staging insert params; DB tests 110/110
- [1.2] Judge contract in `src/judge/judge.ts` (single `Verdict`), DeterministicJudge rules 1–7, BedrockJudge strict JSON/zod, XML escape, fail-closed; tests 100/100 (RED 88/100 first)
- [1.3] `injectionScan`, `piiMask`/`maskPiiInFields`, `computeContentHash` (golden vectors from the pre-C1 formula); tests 146/146

### Files changed
- migrations/0007_judge_structured_verdict.sql; src/db/promotionRepository.ts; src/db/stagingRepository.ts
- src/judge/{judge,deterministicJudge,bedrockJudge}.ts; src/security/{injectionScan,piiMask,hash}.ts
- tests/db/{judgeVerdict.migrate.integration,promotion.integration,stagingRepository.integration,staging.migrate.integration}.test.ts; tests/judge/*; tests/security/{injectionScan,piiMask,contentHash}.test.ts
- minimal compile shims: src/promote/promoteService.ts, src/index.ts, src/mcp/tools/remember.ts (rewritten in 3.1/3.2)

### Deviations
- 1.1: compile shims in promoteService/remember; staging.migrate teardown also clears the 0007 ledger row
- 1.2: `normalizeJudgeResult(r, ctx, {itemId?})` optional third arg; index.ts hardcodes confidence 0.9 until 2.1
- 1.3: 10k-char RangeError backstop in detectors (sanitize must map a throw → `sanitize_failed`); `maskPiiInFields` fails closed beyond depth 4; regex refinements (email lookbehind, sentence-ending period, ES verb tails, `<\s*/?\s*gmemo_`)

### Issues
- 30 tests in tests/promote/{promoteService,promoteEmbedding}.test.ts fail until 3.1 (old fakes/signatures)

---

## Batch 2 — 2026-11-07 (D1, then D2 opus ∥ D3+E sonnet)

### Completed
- [2.1] Notifier seam (`logNotifier`, `safeNotify`), config (+`JUDGE_CONFIDENCE_THRESHOLD`, `MANDATORY_REVIEW_TYPES`, `JUDGE_STUB_CONFIDENCE`; −`JUDGE_STUB_VERDICT`; regex-validated 0..1), `notifier` in HandlerDeps/AppServices
- [3.1] `sanitize.ts` (S1–S4, fail-closed), `routing.ts` (pure R1–R8), PromoteService rewrite (persistMasked, context fail-closed, normalizeJudgeResult, stale → queue, at-most-once notify, idempotent), index.ts wiring; shared `tests/promote/fakes.ts`; promoteVerdict (32), sanitize (18), routing (16)
- [3.2] remember: `computeContentHash`, stale → `stale_target` + mandatory + notify once
- [3.3] compose drops `JUDGE_STUB_VERDICT`; README/DEVELOPMENT updated

### Verification
- unit 734 passed / 0 failed (106 DB skipped); DB gate 840/840; lint 0; build 0

### Deviations
- 3.1: supersede/deprecate are always mandatory → never embedded at promotion (tests updated); every non-terminal item re-sanitized (persisted accepted items too); R5/R6 keep stored mandatory flag; out-of-table rejected → queue (fail closed); prettier only on new/rewritten files
- 3.2: RED step not observed first

### Issues
- `.env.dev.example` must drop `JUDGE_STUB_VERDICT` (human)

---
