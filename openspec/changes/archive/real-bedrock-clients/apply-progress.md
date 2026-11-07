# Apply Progress — real-bedrock-clients

## Batch 1 — SUCCESS (single worker, T002–T010)

Tasks completed: T001 (human dep add) + T002–T010.

Files created/modified:
- `src/bedrock/client.ts` (new) — `BedrockInvoker` seam, `makeBedrockRuntimeClient`, `sendWithTimeout` (Node 22 AbortController)
- `src/config/index.ts` — `AWS_REGION` + `BEDROCK_MAX_ATTEMPTS` (3) + `BEDROCK_TIMEOUT_MS` (15000) + `anyRealBedrock` superRefine guard
- `src/embedder/bedrockEmbedder.ts` — real Titan v2 `InvokeModelCommand`, 1024 finite-dim assertion, THROW on error (fail-soft in callers)
- `src/judge/bedrockJudge.ts` — real `ConverseCommand` (Haiku), `renderItem` + `parseVerdict`, fail-closed → uncertain
- `src/index.ts` — real-branch ctors pass region + tuning; stub branches unchanged
- `tests/embedder/bedrockEmbedder.invoke.test.ts` (new)
- `tests/judge/bedrockJudge.invoke.test.ts` (new)
- `tests/judge/bedrockJudge.test.ts` (migrated to options-object ctor)
- `tests/embedder/failSoft.test.ts` (migrated to options-object ctor)
- `tests/config/embedderGuards.test.ts` (AWS_REGION guard + tuning coverage)
- `tests/config/promoteConfig.test.ts` (collateral: "real judge" case needed AWS_REGION after new guard)

Gate: `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm test -- --run`
→ build clean, lint clean, **437 tests passed / 0 failed** (14 new).

Deviations from design: none. Collateral fix in `promoteConfig.test.ts` (expected — the
new `anyRealBedrock` guard tightened an existing real-judge config test).

Issues: none.

## Batch 2 — remediation (verify findings) — SUCCESS

Findings closed: H1, H2, M1, M2, M3, L1, L3.
- H1 `parseVerdict` word-boundary match (fail-closed hardening)
- H2 log the caught error in `evaluate()` catch
- M1 XML-delimited untrusted fields + anti-injection system-prompt clause (`renderItem`)
- M2 `BedrockInvoker` tightened `any`→`object`/`unknown`, eslint-disables dropped
- M3 non-finite element embedder test (REQ-02)
- L1 `JUDGE_STUB_VERDICT` default → `uncertain`
- L3 loosened over-constrained log assertion

Files: `src/judge/bedrockJudge.ts`, `src/bedrock/client.ts`, `src/config/index.ts`,
`tests/judge/bedrockJudge.test.ts`, `tests/judge/bedrockJudge.invoke.test.ts`,
`tests/embedder/bedrockEmbedder.invoke.test.ts`.

Gate: build clean, lint clean, **442 tests / 0 failed** (5 new). Verify → PASS.
