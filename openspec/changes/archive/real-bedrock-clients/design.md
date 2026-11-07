# Design: Real Bedrock Clients (Embedder + Judge invokeModel)

## FLAGS — decisions the orchestrator must resolve before/while this lands

1. **New runtime dependency, human-installed out-of-band.** This change requires
   `@aws-sdk/client-bedrock-runtime`. Per the ENFORCED tooling policy agents run
   `pnpm install --frozen-lockfile` only — a human must run `pnpm add @aws-sdk/client-bedrock-runtime`
   and commit `pnpm-lock.yaml`. Until that lands, the new Bedrock code and its tests fail with
   `ERR_MODULE_NOT_FOUND`. This is the SAME accepted pending-install state already documented for
   `aws-jwt-verify` (see `tests/auth/authenticator.test.ts` header). **No other new deps are needed**
   — timeouts use the Node 22 built-in `AbortController`, not `@smithy/node-http-handler`.

2. **Claude 3.5 Haiku almost certainly needs a cross-region inference-profile id.** The proposal's
   "default model `anthropic.claude-3-5-haiku`" is not a callable Bedrock id. On-demand Haiku 3.5 is
   typically only invocable through a regional inference profile, e.g.
   `us.anthropic.claude-3-5-haiku-20241022-v1:0` (EU/APAC have their own prefixes). `ConverseCommand`
   accepts inference-profile ids in `modelId`, so this is **config-only** (`BEDROCK_MODEL_ID`) with
   **zero code change** — but the operator must supply the fully-qualified id for the deploy region.
   There is no hardcoded default in code; `superRefine` already requires `BEDROCK_MODEL_ID` on the real path.

3. **Constructor signatures change → two existing tests must be updated.** Both classes currently take
   a bare `modelId: string` and rely on `invokeModel()` throwing "not implemented". This change moves
   them to an options object (`{ modelId, region, ... , client? }`). The existing
   `tests/judge/bedrockJudge.test.ts` (fail-closed) and `tests/embedder/failSoft.test.ts` (fail-soft)
   construct with a bare string and MUST be migrated to the new signature. Their security semantics
   (judge → `uncertain`, embedder → throws) are PRESERVED and re-asserted using an injected throwing
   fake client. Listed as `Modify` below.

4. **`AWS_REGION` is read explicitly via zod and passed to the client**, not left to the SDK's own
   env auto-pickup. This is deliberate — it matches the project's "no hidden config, fail-fast at boot"
   convention (see `COGNITO_*`, `BEDROCK_*` handling). Confirming, not a blocker.

## Technical Approach

Drop real `invokeModel` bodies into the two existing DEFERRED skeletons behind the seams that already
exist. Nothing about the `Embedder` / `Judge` interfaces, the composition-root stub branches, or the
`PromoteService` / recall wiring changes. The only structural addition is a tiny shared Bedrock client
module (`src/bedrock/client.ts`) that centralises client construction and the retry/timeout policy so
the embedder and judge cannot drift apart.

The design follows the codebase's established seam pattern exactly (`src/auth/authenticator.ts`
`CognitoVerifier`): declare a **narrow structural interface** over the one SDK method we use (`.send`),
inject it at construction, default it to a real `BedrockRuntimeClient` built from config. Tests inject a
`{ send: vi.fn() }` fake — no live AWS, no `vi.mock` gymnastics required, and command inputs are directly
assertable.

- **Embedder** (`src/embedder/bedrockEmbedder.ts`): `InvokeModelCommand` → Amazon Titan Text Embeddings V2.
  Request `{ inputText, dimensions: 1024, normalize: true }`; parse `response.body`; assert
  `embedding.length === EMBEDDING_DIM`; **THROW** on any error/mismatch (fail-soft is the caller's job).
- **Judge** (`src/judge/bedrockJudge.ts`): `ConverseCommand` (model-agnostic) → classify reply into
  `Verdict`; unmapped/empty → `uncertain`. `evaluate()` keeps its existing catch-all so any throw
  becomes `uncertain` (**fail-closed**, never `accepted`).

## Architecture Decisions

### Decision: Client lifecycle — one client per class instance, constructor-built from region, with an injected seam

**Choice**: Each `BedrockEmbedder` / `BedrockJudge` owns ONE `BedrockRuntimeClient`, constructed in its
constructor from the injected `region` (+ `maxAttempts`). A shared factory `makeBedrockRuntimeClient()`
builds it. Both constructors also accept an OPTIONAL `client?: BedrockInvoker` (the narrow seam) that
short-circuits construction — this is the test injection point and the only thing tests touch.

**Alternatives considered**:
- *Lazy module-level singleton client* (one global, shared by both). Rejected: introduces global mutable
  state, makes region/timeout non-injectable, and fights the codebase's "build singletons at the
  composition root, inject them" convention (`src/index.ts`). It also complicates test isolation.
- *Construct the client at the composition root and inject it fully* (like `CognitoJwtVerifier`).
  Reasonable, but the embedder/judge are the only Bedrock consumers and each needs exactly one client
  keyed to its own `modelId`; building it inside the class (from injected region) keeps `src/index.ts`
  from growing two more `new BedrockRuntimeClient(...)` blocks while STILL being fully mockable via the
  `client?` seam. This is the smaller, more cohesive change.

**Rationale**: The embedder and judge are process-lifetime singletons built once at the composition root
(`src/index.ts` §5e/§5h), so "one client per instance" == "one client per process" in practice — no churn.
The narrow `BedrockInvoker` seam is the exact pattern `CognitoAuthenticator` already uses for
`CognitoVerifier`, so it reads as idiomatic to this team and needs no live AWS in tests.

### Decision: Timeout via `AbortController`, retries via SDK `maxAttempts` — no extra dependency

**Choice**: Per-request timeout is enforced with a Node built-in `AbortController` + `setTimeout`, passing
`{ abortSignal }` to `client.send(command, { abortSignal })`. Retries use the SDK's own
`maxAttempts` client option (standard retry mode).

**Alternatives considered**:
- *`requestHandler: new NodeHttpHandler({ requestTimeout })`*. Rejected: `NodeHttpHandler` lives in
  `@smithy/node-http-handler`, a transitive package — importing it directly means depending on a
  package we didn't declare, which is fragile and violates "no new runtime deps unless unavoidable".
- *No timeout, rely on SDK socket defaults*. Rejected: a hung Bedrock connection would stall the
  fail-closed promotion path (judge) or the fail-soft recall path (embedder) far longer than acceptable.

**Rationale**: `AbortController` is a Node 22 built-in (engines require `>=22`), so it solves the problem
with the standard library and zero new deps — exactly what the YAGNI/dependency rules prescribe.

### Decision: One shared `src/bedrock/client.ts` (interface + factory + timeout helper)

**Choice**: Extract the `BedrockInvoker` interface, `makeBedrockRuntimeClient({ region, maxAttempts })`,
and `sendWithTimeout(client, command, timeoutMs)` into a single ~30-line module consumed by both classes.

**Alternatives considered**:
- *Inline the client construction + timeout wrapper in each class*. Rejected: identical ~10 lines
  (client build, abort wiring, retry policy) would live in two files and could silently diverge — this
  is real, stable, two-consumer duplication, which the extraction rule explicitly permits.

**Rationale**: Centralises the retry/timeout policy so there is ONE place to tune it, and gives tests a
single narrow type to implement. It is not a speculative abstraction — both consumers exist in this change.

### Decision: Embedder THROWS, Judge fails CLOSED — unchanged, re-asserted

**Choice**: Preserve the two opposite error contracts already encoded in the skeletons and their tests.
The embedder propagates every error (bad response, dimension mismatch, AWS failure, timeout/abort). The
judge's `invokeModel` may throw freely; the existing `evaluate()` try/catch maps any throw — and any
unmapped/empty reply — to `uncertain`.

**Alternatives considered**: Making the embedder fail-soft internally (return `null`/zeros). Rejected
outright and already documented in-code: a fabricated vector silently corrupts semantic search. Fail-soft
is the caller's responsibility (`tests/embedder/failSoft.test.ts` `embedOrNull`).

**Rationale**: These are load-bearing security/correctness invariants from `docs/04` (LLM down → uncertain,
never accepted) and the embedder header comment. This change must not weaken them.

## Data Flow

    PromoteService.sanitize+judge ──→ Judge.evaluate(item)
                                          │  try/catch (fail-CLOSED)
                                          ▼
                             BedrockJudge.invokeModel(item)
                                          │  ConverseCommand(system+user)
                                          ▼
                    sendWithTimeout(client, cmd, timeoutMs)  ──abort──▶ throw → 'uncertain'
                                          │  output.message.content[0].text
                                          ▼
                          parseVerdict(text) → accepted | rejected | uncertain
                                          (unmapped / empty → uncertain)

    recall handler / PromoteService.embed ──→ Embedder.embed(text)   (caller wraps fail-SOFT → null)
                                                     │
                                                     ▼
                                    BedrockEmbedder.invokeModel(text)
                                                     │  InvokeModelCommand(Titan v2 JSON)
                                                     ▼
                            sendWithTimeout(client, cmd, timeoutMs)  ──abort/AWS err──▶ THROW
                                                     │  decode(body) → { embedding }
                                                     ▼
                        assert embedding.length === 1024  ──mismatch──▶ THROW
                                                     │
                                                     ▼
                                          number[1024]  → caller

## Embedder — Titan v2 request/response (exact shapes)

Request (body is a JSON string encoded to `Uint8Array`):

    const payload = { inputText: text, dimensions: EMBEDDING_DIM /* 1024 */, normalize: true };
    const command = new InvokeModelCommand({
      modelId: this.modelId,                 // e.g. amazon.titan-embed-text-v2:0
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

Response parsing + assertions (all failures THROW):

    const res = await sendWithTimeout(this.client, command, this.timeoutMs);
    const json = JSON.parse(new TextDecoder().decode(res.body as Uint8Array));
    const embedding = json.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      throw new Error(`BedrockEmbedder: expected ${EMBEDDING_DIM}-dim vector, got ${...}`);
    }
    // optional: assert every element is a finite number (guards NaN/Infinity poisoning pgvector)
    return embedding as number[];

Notes: `response.body` is a `Uint8Array` in AWS SDK v3 (decode with `TextDecoder`). `dimensions: 1024`
locks the vector to `EMBEDDING_DIM`; the explicit length assertion is the hard 1024 lock-in — a
short/long/garbled response can never reach `pgvector`. No `try/catch` here: aborts, AWS errors, JSON
parse failures, and mismatches all propagate.

## Judge — Converse request + verdict parsing

`ConverseCommand` is model-agnostic and is the right choice for a swappable `BEDROCK_MODEL_ID` (it works
uniformly across Anthropic Claude, Titan, etc.), so a Haiku → Sonnet swap is a config change only.

Request:

    const command = new ConverseCommand({
      modelId: this.modelId,                 // fully-qualified / inference-profile id (see FLAG 2)
      system: [{ text: SYSTEM_PROMPT }],     // instructs: reply with exactly one word: accepted|rejected|uncertain
      messages: [{ role: 'user', content: [{ text: renderItem(item) }] }],
      inferenceConfig: { maxTokens: 16, temperature: 0 },  // deterministic, tiny — it's a classifier
    });

`renderItem(item)` serialises op/type/title/summary/body/fields into a compact prompt. Parsing:

    const res = await sendWithTimeout(this.client, command, this.timeoutMs);
    const text = res.output?.message?.content?.find((b) => 'text' in b)?.text ?? '';
    return parseVerdict(text);   // normalise: trim + lowercase, then map

`parseVerdict` maps a reply to a `Verdict` by scanning the normalised text for the tokens `accepted` /
`rejected` / `uncertain`. **Anything unmapped, ambiguous (multiple verdict tokens), or empty → `uncertain`.**
Because `evaluate()` already wraps `invokeModel` in a catch-all, a thrown parse guard or an AWS/timeout
error also yields `uncertain` — the classifier is fail-closed by construction and can never emit
`accepted` on doubt.

## Config additions (zod, matching existing conventions)

Reuse existing fields; add three. Follow the file's existing styles (`z.coerce.number()...default()` like
`SEMANTIC_FALLBACK_*`; `.min(1).optional()` guarded in `superRefine` like `BEDROCK_MODEL_ID`).

- **Reuse** `BEDROCK_MODEL_ID` (judge) and `BEDROCK_EMBEDDING_MODEL_ID` (embedder) — already present and
  already guarded (required when the corresponding stub is off). No change.
- **Add** `AWS_REGION: z.string().min(1).optional()` — required (via `superRefine`) whenever EITHER real
  Bedrock client is active.
- **Add** `BEDROCK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3)`.
- **Add** `BEDROCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(15000)`.

New `superRefine` guard (place beside the existing embedder/judge guards):

    const anyRealBedrock = !cfg.EMBEDDER_STUB || !cfg.JUDGE_STUB;
    if (anyRealBedrock && !cfg.AWS_REGION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_REGION'],
        message: 'AWS_REGION is required when a real Bedrock client is active (EMBEDDER_STUB=false or JUDGE_STUB=false).',
      });
    }

The existing prod guards (`EMBEDDER_STUB`/`JUDGE_STUB` forbidden in production) already force the real
Bedrock path — and therefore `AWS_REGION` — in production. No new prod-specific guard is needed beyond the
`anyRealBedrock` requirement. One shared timeout/attempts pair is used for both clients (see Retry/timeout).

## Composition-root wiring (`src/index.ts`)

Keep both stub branches (§5e judge, §5h embedder) exactly as-is. On the real branches, pass region + tuning:

    // §5e real branch
    judge = new BedrockJudge({
      modelId: config.BEDROCK_MODEL_ID!,
      region: config.AWS_REGION!,
      maxAttempts: config.BEDROCK_MAX_ATTEMPTS,
      timeoutMs: config.BEDROCK_TIMEOUT_MS,
    });

    // §5h real branch
    embedder = new BedrockEmbedder({
      modelId: config.BEDROCK_EMBEDDING_MODEL_ID!,
      region: config.AWS_REGION!,
      maxAttempts: config.BEDROCK_MAX_ATTEMPTS,
      timeoutMs: config.BEDROCK_TIMEOUT_MS,
    });

`config.AWS_REGION!` is safe on these branches: `superRefine` guarantees it (same non-null pattern already
used for `BEDROCK_MODEL_ID!` / `BEDROCK_EMBEDDING_MODEL_ID!`). `PromoteService` and the recall-handler
wiring are untouched — they consume the `Judge` / `Embedder` interfaces.

## Test strategy (vitest, NO real AWS)

Primary pattern — **inject a fake `BedrockInvoker`** (mirrors the `CognitoVerifier` fake in
`tests/auth/authenticator.test.ts`); no `vi.mock` of the SDK needed:

    const sendMock = vi.fn();
    const client: BedrockInvoker = { send: sendMock };
    const embedder = new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0', region: 'us-east-1', client });

Embedder cases (`tests/embedder/bedrockEmbedder.invoke.test.ts` — new):
- **Happy path**: `send` resolves `{ body: encode(JSON.stringify({ embedding: number[1024] })) }` →
  `embed()` returns a 1024-length array. Assert the sent command is an `InvokeModelCommand` whose
  `input.modelId` matches and whose decoded `input.body` equals `{ inputText, dimensions: 1024, normalize: true }`.
- **Dimension mismatch**: `send` resolves an embedding of length 512 → `embed()` REJECTS.
- **AWS error**: `send` rejects (e.g. `ThrottlingException`) → `embed()` REJECTS (no fabricated vector).
- **Malformed body**: non-JSON / missing `embedding` → `embed()` REJECTS.

Judge cases (`tests/judge/bedrockJudge.invoke.test.ts` — new):
- **Happy path × 3**: `send` resolves a Converse response whose text is `accepted` / `rejected` /
  `uncertain` → `evaluate()` returns the matching verdict. Assert the sent command is a `ConverseCommand`
  with the expected `modelId`, a `system` block, and one `user` message.
- **Unmapped reply** (`"maybe?"`) → `uncertain`. **Empty reply** (no content / `''`) → `uncertain`.
- **AWS error / timeout**: `send` rejects → `evaluate()` resolves `uncertain` (fail-closed; never throws,
  never `accepted`).

Config cases (extend `tests/config/embedderGuards.test.ts` or add a sibling): `AWS_REGION` required when a
real Bedrock client is active; `BEDROCK_MAX_ATTEMPTS` / `BEDROCK_TIMEOUT_MS` defaults (3 / 15000) and
numeric-string overrides — same `loadFresh()` / `process.exit` spy pattern already in that file.

Migrated existing tests: `tests/judge/bedrockJudge.test.ts` and `tests/embedder/failSoft.test.ts` switch
to the options-object constructor and use an injected throwing fake client to re-prove fail-closed /
fail-soft (see FLAG 3).

`vi.mock('@aws-sdk/client-bedrock-runtime', ...)` remains an available fallback if a future test needs to
assert the *default* (non-injected) client construction, but injection covers all cases here and keeps
tests fast and offline.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Declare `@aws-sdk/client-bedrock-runtime` under `dependencies` (human runs `pnpm add`, commits `pnpm-lock.yaml` — FLAG 1). |
| `src/bedrock/client.ts` | Create | Narrow `BedrockInvoker` interface (`.send`), `makeBedrockRuntimeClient({region,maxAttempts})`, `sendWithTimeout(client,cmd,ms)` (AbortController). Shared retry/timeout policy. |
| `src/embedder/bedrockEmbedder.ts` | Modify | Options-object ctor (`{modelId,region,maxAttempts?,timeoutMs?,client?}`); real `invokeModel` via `InvokeModelCommand` (Titan v2), decode + 1024 assertion, THROW on any error. |
| `src/judge/bedrockJudge.ts` | Modify | Options-object ctor; real `invokeModel` via `ConverseCommand`; `renderItem` + `parseVerdict` (unmapped/empty → uncertain). `evaluate()` fail-closed wrapper unchanged. |
| `src/config/index.ts` | Modify | Add `AWS_REGION`, `BEDROCK_MAX_ATTEMPTS` (3), `BEDROCK_TIMEOUT_MS` (15000); `superRefine` `anyRealBedrock → AWS_REGION` guard. Reuse existing `BEDROCK_MODEL_ID` / `BEDROCK_EMBEDDING_MODEL_ID`. |
| `src/index.ts` | Modify | Pass `region` + tuning into both real-branch constructors; stub branches unchanged. |
| `tests/embedder/bedrockEmbedder.invoke.test.ts` | Create | Happy path + command-input assert; dimension mismatch → throw; AWS error → throw; malformed body → throw (injected fake). |
| `tests/judge/bedrockJudge.invoke.test.ts` | Create | Happy path ×3 verdicts + command-input assert; unmapped/empty → uncertain; AWS error → uncertain. |
| `tests/judge/bedrockJudge.test.ts` | Modify | Migrate to options-object ctor + injected throwing client; keep fail-closed assertions. |
| `tests/embedder/failSoft.test.ts` | Modify | Migrate to options-object ctor + injected throwing client; keep fail-soft (`embedOrNull`) assertions. |
| `tests/config/embedderGuards.test.ts` | Modify | Add `AWS_REGION` guard + `BEDROCK_MAX_ATTEMPTS`/`BEDROCK_TIMEOUT_MS` default/override coverage. |

## Retry / timeout (recommended, config-tunable)

- **`maxAttempts` = 3** (SDK standard retry mode): one try + two retries. Bedrock throttling
  (`ThrottlingException`) and transient 5xx are retryable; the SDK backs off automatically. 3 is
  conservative — enough to ride out a blip without stacking latency.
- **`BEDROCK_TIMEOUT_MS` = 15000** per attempt, enforced by `AbortController`. Embedding calls finish in
  well under a second, so 15s is just a hang ceiling; judge (LLM generation with `maxTokens: 16`) also
  completes comfortably inside it. Worst case ≈ `maxAttempts × timeoutMs`.
- **One shared pair for both clients** to start. If judge latency later proves materially different from
  embedding, split into `BEDROCK_JUDGE_TIMEOUT_MS` / `BEDROCK_EMBED_TIMEOUT_MS` then — NOT now (YAGNI;
  no evidence today that one ceiling is insufficient).
- Credentials come from the **default AWS credential provider chain** (task role in prod) — never in code,
  per the proposal. Only `region` is passed explicitly.
