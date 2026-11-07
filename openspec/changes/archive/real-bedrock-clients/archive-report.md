# Archive Report — real-bedrock-clients

## Outcome: DONE (verify PASS after remediation)

Wired the two REAL AWS Bedrock clients as drop-in replacements behind the existing
injectable seams — zero orchestration change.

## Delivered
- `src/bedrock/client.ts` (new): narrow `BedrockInvoker` seam, `makeBedrockRuntimeClient`,
  `sendWithTimeout` (Node 22 `AbortController`, no extra deps).
- `src/embedder/bedrockEmbedder.ts`: real Titan Text Embeddings V2 (`InvokeModelCommand`,
  `{ inputText, dimensions: 1024, normalize: true }`), 1024 finite-dim lock-in, THROW on
  any error (fail-soft stays in callers — never a fabricated vector).
- `src/judge/bedrockJudge.ts`: real `ConverseCommand` (Claude Haiku via config model id),
  `renderItem` (XML-delimited untrusted fields) + anti-injection system prompt +
  word-boundary `parseVerdict`; `evaluate()` fail-closed → `uncertain`, error now logged.
- `src/config/index.ts`: `AWS_REGION` (+ `anyRealBedrock` superRefine guard),
  `BEDROCK_MAX_ATTEMPTS` (3), `BEDROCK_TIMEOUT_MS` (15000); reuse `BEDROCK_MODEL_ID` /
  `BEDROCK_EMBEDDING_MODEL_ID`; `JUDGE_STUB_VERDICT` default → `uncertain`.
- `src/index.ts`: real-branch ctors pass region + tuning; stub branches untouched.
- Dep: `@aws-sdk/client-bedrock-runtime@^3.1100.0` (only new runtime dep).
- Tests: SDK mocked via injected `{ send }` fake, NO live AWS. **442 tests / 0 failed.**

## Verify
FAIL → remediated (2 HIGH + 3 MEDIUM + 2 LOW) → PASS. Fail-closed (judge) & fail-soft
(embedder) invariants preserved and strengthened. No credentials/secrets in code.

## Operator prerequisites (before real Bedrock runs in an env)
- Set `AWS_REGION`, `BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`, and
  `BEDROCK_MODEL_ID` = a fully-qualified / inference-profile id for the region
  (e.g. `us.anthropic.claude-3-5-haiku-20241022-v1:0`).
- Task/exec role needs `bedrock:InvokeModel` (+ Converse) and model access enabled.
- Credentials via default AWS provider chain (task role / SSO) — never in code.

## Follow-ups (backlog)
- Injection classifier as a dedicated sanitize step (docs/04) — XML delimiters + system
  prompt are the interim mitigation.
- Optional split `BEDROCK_JUDGE_TIMEOUT_MS` / `BEDROCK_EMBED_TIMEOUT_MS` if latencies diverge.
- Query-embedding cache; backfill of pre-0005 embeddings.
- Terraform/IaC (Change 10): IAM `bedrock:InvokeModel`, VPC PrivateLink to Bedrock, model access.
