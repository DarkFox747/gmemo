# Proposal — real-bedrock-clients

## Why
`hybrid-search` and `promotion-pipeline` shipped with the two Bedrock calls
DEFERRED behind injectable seams:
- `BedrockEmbedder.invokeModel` (`src/embedder/bedrockEmbedder.ts`) throws — so
  semantic search currently runs on the non-semantic `StubEmbedder` (rails only).
- `BedrockJudge.invokeModel` (`src/judge/bedrockJudge.ts`) throws — so the
  promotion judge always fails closed to `uncertain` in non-stub mode.

The user wants to go to production. This change wires the REAL Bedrock clients as
drop-in replacements of those two private methods, with ZERO orchestration change.

## Chosen approach
Add `@aws-sdk/client-bedrock-runtime` (the one unavoidable new runtime dependency)
and implement the two deferred `invokeModel` bodies:

- **Embedder** → `InvokeModelCommand` against Amazon Titan Text Embeddings V2
  (`amazon.titan-embed-text-v2:0`). Request `{ inputText, dimensions: 1024,
  normalize: true }`; parse `response.body.embedding`; assert length ===
  `EMBEDDING_DIM` (throw on mismatch — callers already do fail-soft). Does NOT
  swallow errors (a fabricated vector would corrupt search).
- **Judge** → `ConverseCommand` (model-agnostic; default `anthropic.claude-3-5-haiku`
  on Bedrock). System prompt asks for a strict accepted/rejected/uncertain verdict;
  parse the reply → `Verdict`; any unmapped/garbled reply → `uncertain`. `evaluate()`
  already wraps this fail-closed.

Both clients: default AWS credential chain (task role on Fargate / SSO locally),
region from config (`AWS_REGION`), sane timeout + limited retries. NO credentials
in code, NO secrets committed.

## Scope boundaries
IN: the two `invokeModel` bodies; the AWS SDK dep; region config; composition-root
wiring (pass region); unit tests with the AWS SDK client mocked (request shape,
response parsing, error → embedder-throws / judge-uncertain, dimension-mismatch guard).

OUT (deferred to later changes): Terraform/IaC, IAM policy provisioning, VPC
PrivateLink, model-access enablement, GitHub-OIDC verify, query-embedding cache,
backfill of pre-0005 embeddings.

## Affected Areas
| Area | Files | Change |
|------|-------|--------|
| Embedder | `src/embedder/bedrockEmbedder.ts` | implement `invokeModel` (Titan v2 InvokeModel) |
| Judge | `src/judge/bedrockJudge.ts` | implement `invokeModel` (Converse) |
| Config | `src/config/index.ts` | region + confirm judge model-id fields |
| Composition | `src/index.ts` | pass region to constructors |
| Deps | `package.json` / lockfile | add `@aws-sdk/client-bedrock-runtime` |
| Tests | `tests/embedder/*`, `tests/judge/*` | unit tests with SDK client mocked |

## Constraints
- pnpm-ONLY (add via `pnpm add`, frozen thereafter).
- Fail-soft (embedder throws → callers degrade) vs fail-closed (judge → uncertain)
  contracts preserved.
- Hard dimension lock-in: Titan must return exactly 1024 floats or embed throws.
- No new orchestration; seams unchanged.
