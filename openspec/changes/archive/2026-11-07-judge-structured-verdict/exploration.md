# Exploration: judge-structured-verdict (C1)

One crombie-explore-high scope (promotion pipeline, judge, sanitize, staging write path, tests). Status: COMPLETE.

## Current state (evidence)
- `Judge.evaluate(item) → Verdict` (`'accepted'|'rejected'|'uncertain'`), no context, criterion or confidence (`src/judge/judge.ts:7-20`). `Verdict` is also re-declared in `src/db/promotionRepository.ts:26`.
- BedrockJudge: one-word prompt, `maxTokens 16`, word-boundary `parseVerdict` (`src/judge/bedrockJudge.ts:19-21,70-78,105`). Fail-closed catch → `uncertain` + warn (`:91-98`).
- DeterministicJudge returns the constant `JUDGE_STUB_VERDICT` (`src/judge/deterministicJudge.ts:14-18`, `src/config/index.ts:43`, `src/index.ts:124`). No test covers `JUDGE_STUB_VERDICT`.
- PromoteService (`src/promote/promoteService.ts:111-223`):
  1. fetch promotable items;
  2. skip `rejected`; reuse persisted `accepted`/`uncertain` **without re-sanitizing**;
  3. `pending` → `assertNoSecrets` → judge → `recordVerdict` (reason always null);
  4. accepted → embed fail-soft → `applyAccepted` (per-item txn); stale → quarantine `stale_target`; duplicate → quarantine `duplicate_content`; rejected → quarantine `judge_reason ?? 'judge_rejected'`; uncertain → left pending;
  5. terminal state + `finalizeSession` + audit.
- Persisted: `staging_item.judge_state` enum (pending|accepted|uncertain|rejected), `judge_reason`, `sanitize_flags jsonb NOT NULL DEFAULT '{}'` (**already exist**, `migrations/0003_staging.sql:75-77`). `sanitize_flags` is never written. The quarantine table (`0004:41-67`) has `judge_reason NOT NULL` and no criterion column.
- `secretScan.ts`: 9 category regexes. `scanForSecrets` returns categories only (no ranges); `assertNoSecrets` throws PERMISSION_DENIED. Called at capture (`remember.ts:69-75`, rejects, no row) and at promotion (quarantine, redact).
- Stale-target conflict: capture marks a stale handle `uncertain` (`remember.ts:63-64`), while promotion quarantines it as `stale_target` (`promoteService.ts:182-184`).
- Uncertain items in finalized sessions are orphaned: there is no review path (`findOpenSessionId` requires `open`).
- Judge context: `recall` (BM25, no embedder, but it runs a COUNT) or `recallSemantic` (needs an embedding). The judge call runs outside any txn, so a pre-judge read is feasible.
- No Notifier, PII masking or injection detector exists. Logger = JSON lines (`src/observability/logger.ts:22-47`).
- Config patterns: CSV transform+refine (`COGNITO_CLIENT_ID_ALLOWLIST`), coerced numbers with min (`BEDROCK_*`). Prod guard = superRefine + composition-root double check.
- Migrations: next is `0007`. Idempotency patterns: enum `DO $$ … EXCEPTION WHEN duplicate_object`, `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`. Constraints need DO-block guards.

## Tests that break
- `tests/promote/promoteService.test.ts`: FakeJudge returns strings; stale→quarantine at 428-443 and 688-698; `judge_rejected` at 349-377.
- `tests/promote/promoteEmbedding.test.ts`: FakeJudge.
- `tests/judge/deterministicJudge.test.ts`: whole file.
- `tests/judge/bedrockJudge.invoke.test.ts`: single-word / parseVerdict cases.
- `tests/staging/fakes.ts`: row shape.

## Risks
- `0007` must not re-add `sanitize_flags`/`judge_reason`.
- Prompt-injection surface grows with the context block and the JSON output, so all context must be XML-delimited as untrusted data.
- Unbounded regex scanning of `fields` at promotion.
