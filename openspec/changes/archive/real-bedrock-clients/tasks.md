# Tasks — real-bedrock-clients

Dependency note: T001 (dep add) is a HUMAN out-of-band prerequisite. All other
tasks can be authored before it lands, but build/test (T009) require it installed.

- [x] T001 (HUMAN) Add `@aws-sdk/client-bedrock-runtime` via `pnpm add`, commit `pnpm-lock.yaml`. Declared in `package.json` dependencies.
- [x] T002 Create `src/bedrock/client.ts`: `BedrockInvoker` interface (narrow, over `.send`), `makeBedrockRuntimeClient({ region, maxAttempts })` factory, `sendWithTimeout(client, command, timeoutMs)` using Node `AbortController` (+ clearTimeout on settle).
- [x] T003 `src/config/index.ts`: add `AWS_REGION` (string optional), `BEDROCK_MAX_ATTEMPTS` (coerce int min 1 default 3), `BEDROCK_TIMEOUT_MS` (coerce int min 1 default 15000); add `superRefine` guard requiring `AWS_REGION` when `EMBEDDER_STUB=false` OR `JUDGE_STUB=false`. Reuse existing `BEDROCK_MODEL_ID` / `BEDROCK_EMBEDDING_MODEL_ID`.
- [x] T004 `src/embedder/bedrockEmbedder.ts`: options-object ctor `{ modelId, region, maxAttempts?, timeoutMs?, client? }`; real `invokeModel` via `InvokeModelCommand` (Titan v2 body `{ inputText, dimensions: EMBEDDING_DIM, normalize: true }`); decode `response.body`; assert 1024 finite numbers; THROW on any error/mismatch.
- [x] T005 `src/judge/bedrockJudge.ts`: options-object ctor `{ modelId, region, maxAttempts?, timeoutMs?, client? }`; real `invokeModel` via `ConverseCommand` (system + user, `maxTokens:16`, `temperature:0`); `renderItem(item)` + `parseVerdict(text)` (unmapped/ambiguous/empty → uncertain); keep `evaluate()` fail-closed wrapper.
- [x] T006 `src/index.ts`: pass `region` + `maxAttempts` + `timeoutMs` into both real-branch constructors (§5e judge, §5h embedder); leave both stub branches unchanged.
- [x] T007 Create `tests/embedder/bedrockEmbedder.invoke.test.ts` (injected fake client): happy path + assert `InvokeModelCommand` input (modelId + decoded body); dimension mismatch → reject; AWS error → reject; malformed body → reject.
- [x] T008 Create `tests/judge/bedrockJudge.invoke.test.ts` (injected fake client): accepted/rejected/uncertain happy paths + assert `ConverseCommand` input; unmapped → uncertain; empty → uncertain; AWS error/timeout → uncertain.
- [x] T009 Migrate `tests/judge/bedrockJudge.test.ts` and `tests/embedder/failSoft.test.ts` to the options-object ctor + injected throwing client; keep fail-closed / fail-soft assertions. Extend `tests/config/embedderGuards.test.ts` with `AWS_REGION` guard + `BEDROCK_MAX_ATTEMPTS`/`BEDROCK_TIMEOUT_MS` default/override coverage.
- [x] T010 Run gate: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm test -- --run`. All green (requires T001 landed).
