# Bedrock Clients Specification

## Purpose

Real Amazon Bedrock clients behind the existing `Embedder` and `Judge` seams: Titan Text Embeddings V2 for embeddings and a Converse-based judge. The judge fails closed, the embedder propagates errors so callers stay fail-soft, and no test touches live AWS.

## Requirements

### Requirement: Titan v2 embedding

`BedrockEmbedder.embed(text)` MUST call Amazon Titan Text Embeddings V2 via `InvokeModelCommand` with body `{ inputText: text, dimensions: 1024, normalize: true }` and return the embedding as a `number[]`. The `modelId` MUST come from injected config, never hardcoded.

Source: real-bedrock-clients

#### Scenario: Happy path

- GIVEN a fake client returning a valid body
- WHEN embedding text
- THEN a 1024-length array is returned and the sent command is an `InvokeModelCommand` with the configured `modelId`

### Requirement: Dimension lock-in

The embedder MUST assert the result is an array of exactly `EMBEDDING_DIM` (1024) finite numbers; any other length, a non-array or a non-finite element MUST make `embed()` throw. A vector MUST NEVER be fabricated, truncated or padded.

Source: real-bedrock-clients

#### Scenario: Wrong dimension

- GIVEN a response with a different length
- WHEN embedding
- THEN `embed()` rejects

### Requirement: Embedder propagates errors

On any AWS error, timeout or abort, malformed body or dimension mismatch, `BedrockEmbedder.embed()` MUST reject. It MUST NOT return `null`, zeros or a partial vector. Callers (recall handler, `PromoteService`) keep their fail-soft wrappers.

Source: real-bedrock-clients

#### Scenario: AWS error

- GIVEN the client throws
- WHEN embedding
- THEN `embed()` rejects and the caller's fail-soft path handles it

### Requirement: Converse judge

`BedrockJudge.invokeModel(item)` MUST call Bedrock via `ConverseCommand` with the injected `modelId`, a system prompt requesting a single-word verdict, one user message rendering the staged item, and `inferenceConfig` `{ maxTokens: 16, temperature: 0 }`.

Source: real-bedrock-clients

#### Scenario: Verdict mapping

- GIVEN replies of accepted, rejected and uncertain
- WHEN judged
- THEN each maps to the matching verdict

### Requirement: Fail-closed verdict parsing

The judge MUST map the model reply to `accepted`, `rejected` or `uncertain`; an unmapped, ambiguous (multiple verdict tokens) or empty reply MUST resolve to `uncertain`. `BedrockJudge.evaluate()` MUST keep wrapping `invokeModel` so any AWS error, timeout or parse guard resolves to `uncertain`, and MUST NEVER resolve to `accepted` on doubt.

Source: real-bedrock-clients

#### Scenario: Empty or ambiguous reply

- GIVEN an empty reply, an unmapped reply or a reply with several verdict tokens
- WHEN judged
- THEN `uncertain` is returned

#### Scenario: AWS timeout

- GIVEN the call times out
- WHEN evaluating
- THEN `uncertain` is returned, never `accepted`

### Requirement: Shared client module and injectable seam

`src/bedrock/client.ts` MUST provide a narrow `BedrockInvoker` interface over `.send`, a `makeBedrockRuntimeClient({ region, maxAttempts })` factory and `sendWithTimeout(client, command, timeoutMs)` using Node's `AbortController`; the only new dependency is `@aws-sdk/client-bedrock-runtime`. `BedrockEmbedder` and `BedrockJudge` MUST accept an options object with an optional `client?: BedrockInvoker`, and all unit tests MUST use an injected fake `{ send: vi.fn() }` with no live AWS calls or credentials.

Source: real-bedrock-clients

#### Scenario: Offline tests

- GIVEN an injected fake client
- WHEN running the Bedrock unit tests
- THEN no network or credentials are used

### Requirement: Bedrock configuration

`AWS_REGION` MUST be required (via `superRefine`) whenever a real Bedrock client is active (`EMBEDDER_STUB=false` OR `JUDGE_STUB=false`). `BEDROCK_MAX_ATTEMPTS` (default 3) and `BEDROCK_TIMEOUT_MS` (default 15000) MUST exist. `BEDROCK_MODEL_ID` and `BEDROCK_EMBEDDING_MODEL_ID` are reused unchanged. Credentials MUST come from the default AWS provider chain, never from config.

Source: real-bedrock-clients

#### Scenario: Missing region

- GIVEN a real Bedrock client is active and `AWS_REGION` is unset
- WHEN configuration is loaded
- THEN boot fails fast

### Requirement: Composition root shape

`src/index.ts` MUST keep both stub branches and only pass `region` and tuning into the real-branch constructors. `PromoteService` and recall wiring MUST NOT change, since they consume the `Judge` and `Embedder` interfaces.

Source: real-bedrock-clients

#### Scenario: Stub branches intact

- GIVEN stubs enabled
- WHEN the app boots
- THEN the stub implementations are used and no AWS client is constructed

## History

None.
