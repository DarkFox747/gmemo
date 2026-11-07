# Spec — real-bedrock-clients

## Requirements

### REQ-01 — Real Titan v2 embedding
`BedrockEmbedder.embed(text)` MUST call Amazon Titan Text Embeddings V2 via
`InvokeModelCommand` and return the model's embedding as a `number[]`.
- Request body MUST be `{ inputText: text, dimensions: 1024, normalize: true }`.
- `modelId` MUST come from injected config, never hardcoded.

### REQ-02 — Hard 1024-dim lock-in
The embedder MUST assert the returned embedding is an array of exactly
`EMBEDDING_DIM` (1024) finite numbers. Any other length, a non-array, or a
non-finite element MUST cause `embed()` to THROW. A vector MUST NEVER be
fabricated, truncated, or padded.

### REQ-03 — Embedder propagates errors (fail-soft is the caller's job)
On any AWS error, timeout/abort, malformed body, or dimension mismatch,
`BedrockEmbedder.embed()` MUST reject/throw. It MUST NOT return `null`, zeros,
or a partial vector. Callers (recall handler, PromoteService) retain their
existing fail-soft wrappers.

### REQ-04 — Real judge via Converse
`BedrockJudge.invokeModel(item)` MUST call Bedrock via `ConverseCommand` with
the injected `modelId`, a system prompt instructing a single-word verdict, one
user message rendering the staged item, and `inferenceConfig` `{ maxTokens: 16,
temperature: 0 }`.

### REQ-05 — Verdict parsing, fail-closed
The judge MUST map the model reply to `accepted | rejected | uncertain`. Any
unmapped, ambiguous (multiple verdict tokens), or empty reply MUST resolve to
`uncertain`. `BedrockJudge.evaluate()` MUST continue to wrap `invokeModel` so
any AWS error, timeout, or thrown parse guard resolves to `uncertain` — and
MUST NEVER resolve to `accepted` on doubt.

### REQ-06 — Shared client module
A single `src/bedrock/client.ts` MUST provide the narrow `BedrockInvoker`
interface (over `.send`), a `makeBedrockRuntimeClient({ region, maxAttempts })`
factory, and a `sendWithTimeout(client, command, timeoutMs)` helper using a Node
built-in `AbortController`. No new dependency beyond `@aws-sdk/client-bedrock-runtime`.

### REQ-07 — Injectable client seam (testability)
Both `BedrockEmbedder` and `BedrockJudge` MUST accept an options object with an
OPTIONAL `client?: BedrockInvoker` that short-circuits real client construction.
All unit tests MUST use an injected fake `{ send: vi.fn() }` — NO live AWS calls,
no real credentials.

### REQ-08 — Config
`AWS_REGION` MUST be added and REQUIRED (via `superRefine`) whenever a real
Bedrock client is active (`EMBEDDER_STUB=false` OR `JUDGE_STUB=false`).
`BEDROCK_MAX_ATTEMPTS` (default 3) and `BEDROCK_TIMEOUT_MS` (default 15000) MUST
be added. Existing `BEDROCK_MODEL_ID` (judge) and `BEDROCK_EMBEDDING_MODEL_ID`
(embedder) MUST be reused unchanged. No credentials in config — credentials come
from the default AWS provider chain.

### REQ-09 — Composition root unchanged in shape
`src/index.ts` MUST keep both stub branches intact and only pass `region` +
tuning into the real-branch constructors. `PromoteService` and recall wiring
MUST NOT change — they consume the `Judge` / `Embedder` interfaces.

## Acceptance Criteria
- Embedder: happy path returns 1024-length array; dimension mismatch, AWS error,
  and malformed body each cause `embed()` to reject. Sent command is an
  `InvokeModelCommand` with the expected `modelId` and decoded body.
- Judge: `accepted`/`rejected`/`uncertain` replies map correctly; unmapped and
  empty replies → `uncertain`; AWS error/timeout → `uncertain` (never `accepted`).
- Config: boot fails fast when a real Bedrock client is active without `AWS_REGION`;
  `BEDROCK_MAX_ATTEMPTS`/`BEDROCK_TIMEOUT_MS` defaults and overrides validated.
- Migrated `tests/judge/bedrockJudge.test.ts` and `tests/embedder/failSoft.test.ts`
  still assert fail-closed / fail-soft under the new constructor.
- No `.env`, secrets, or credentials committed. Only `region` passed explicitly.
