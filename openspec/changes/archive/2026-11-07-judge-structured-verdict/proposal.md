# Proposal: judge-structured-verdict (C1) — HU-05, HU-06, HU-11.3

## Intent

The TFG document requires every judge decision to record **verdict, criterion, confidence (0..1) and justification**, with a confidence threshold and mandatory human review for sensitive types. It also requires the pipeline to detect embedded instructions (quarantine), mask personal data (non-blocking) and flag leaks with an alert. Today the judge returns one word, the pipeline only scans credentials, and a stale `target_revision` goes to quarantine instead of human review. C1 closes divergences 2 and 4 and lays the review-queue state that C2 exposes.

## Scope

### In Scope
1. **Migration 0007** (idempotent): on `staging_item`: `judge_criterion`, `judge_confidence real CHECK 0..1`, `mandatory_review bool NOT NULL DEFAULT false`, `related_memory_id uuid FK memory SET NULL`, `reviewed_by uuid FK app_user`, `review_decision` enum (`approved`,`rejected`), `review_reason`, `reviewed_at`. On `memory`: `approved_by uuid FK app_user`. (`sanitize_flags` and `judge_reason` already exist and are reused.)
2. **Judge seam**: `evaluate(item, context) → JudgeResult { verdict, criterion, confidence, reason, relatedMemoryId? }`. Criteria: `specificity`, `duplication`, `contradiction`, `grounding`, `confidence`, `security_second_layer`, plus the service-level `stale_target`. One `Verdict` type (remove the duplicate).
3. **Judge context**: up to 3 similar **active** memories of the same project, found by a dedicated BM25 query (`LIMIT 3`, excludes the target, no embedder call), passed as untrusted XML-delimited data.
4. **BedrockJudge**: strict JSON output validated with zod. Invalid JSON, timeout or error → `uncertain`/`confidence` (fail-closed). `relatedMemoryId` is accepted only if it belongs to the supplied context.
5. **DeterministicJudge** (demo + tests): documented, reproducible heuristics yielding all outcomes. Replaces `JUDGE_STUB_VERDICT` with `JUDGE_STUB_CONFIDENCE` (default 0.9).
6. **Routing in PromoteService**:
   - `JUDGE_CONFIDENCE_THRESHOLD` (0.80): accepted below it → `uncertain`/`confidence`.
   - `MANDATORY_REVIEW_TYPES` (default `decision,constraint,domain_rule`) plus every `supersede`/`deprecate`: accepted → not applied, `mandatory_review=true` (queued).
   - `rejected/duplication` → quarantine with `related_memory_id`.
   - `rejected/security_second_layer` → quarantine (redacted), `sanitize_flags.leak=true`, notify `leak_detected`.
   - Model unavailable → never accepted.
7. **Pipeline (sanitize) at promotion**, for every non-terminal item, including those already `uncertain`:
   - credential → quarantine `secret_detected` + `sanitize_flags.leak=true` + notify `leak_detected`;
   - **embedded instructions** → quarantine `embedded_instructions`;
   - **PII masking** (`[EMAIL]`, `[PHONE]`, `[ID]`: emails, phones, DNI/CUIT) persisted on the staging row and recorded in `sanitize_flags.pii`, non-blocking, `content_hash` recomputed.
8. **Notifier seam** `notify(projectId, event)`; demo implementation = structured log (`review_enqueued`, `leak_detected`), category names only. `review_enqueued` fires whenever an item lands in the queue.
9. **HU-11.3**: stale `target_revision` → `uncertain`/`stale_target` + `mandatory_review=true` at capture **and** at promotion (no quarantine).
10. Tests for HU-06.1–6 and HU-05; promotion idempotency regression; config guard tests for the new variables.

### Out of Scope
- Review queue API, approve/reject (C2). Quarantine `criterion`/`reason_code` columns, range redaction and restore (C3).
- SES email (the Notifier logs only).
- Capture-time behaviour for credentials: `remember` keeps hard-rejecting (HU-03.4 ✅).

## Approach

Extend the existing seams (Judge, PromotionRepository, config, composition root) and add two small pure modules next to `secretScan.ts`: `injectionScan.ts` and `piiMask.ts`. Routing stays in `PromoteService`, with one decision function `route(judgeResult, item, config)` that is unit-testable. The review queue is a **state**, not a new table: `promoted_at IS NULL AND judge_state <> 'rejected' AND reviewed_at IS NULL AND (judge_state = 'uncertain' OR mandatory_review)`. C2 reads that state.

## Decisions taken (auto mode)
- **D1**: `remember` keeps rejecting secrets at capture. The quarantine + leak path applies at promotion, and later to web-direct writes (C5).
- **D2**: Judge context uses BM25 via a dedicated `LIMIT 3` query (no embedder cost before the judge).
- **D3**: `JUDGE_STUB_VERDICT` is removed in favour of heuristics. Compose drops it and adds `JUDGE_STUB_CONFIDENCE` only if non-default.
- **D4**: Mandatory-review accepted items keep `judge_state='accepted'` with `mandatory_review=true`. They are not applied until approved (C2).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `migrations/` | New | 0007 |
| `src/judge` | Modified | Seam, Bedrock JSON, deterministic heuristics |
| `src/security` | New/Modified | Injection detector, PII masking |
| `src/promote`, `src/db/promotionRepository`, `src/db/memoryRepository` | Modified | Routing, context query, verdict persistence |
| `src/mcp/tools/remember`, `src/db/stagingRepository` | Modified | Stale → stale_target + mandatory; projections |
| `src/notify` (new), `src/index.ts`, `src/mcp/context.ts`, `src/config` | New/Modified | Notifier seam, wiring, config |
| `tests/**` | Modified/New | Judge, promote, security, config, integration |
| `docker-compose.yml`, docs | Modified | Config variables |

## Risks

| Risk | L | Mitigation |
|---|---|---|
| Prompt injection via context or JSON | Med | XML delimiting, zod strict, relatedMemoryId ∈ context, fail-closed |
| PII masking changes content_hash → duplicate detection | Med | Recompute hash before the judge; test |
| Large test rewrite | High | Tests first per HU criterion |
| 0007 re-adding existing columns | Low | `IF NOT EXISTS`, DO-block guards |

## Rollback Plan
Revert the C1 commit. Migration 0007 is additive only (nullable / defaulted columns plus one enum), so old code ignores it.

## Success Criteria
- [ ] Tests for HU-06 criteria 1–6 and HU-05 (format, extension, credential + leak + alert, embedded instructions, PII masking) green.
- [ ] Stale target → uncertain/stale_target/mandatory, no quarantine row.
- [ ] Promotion idempotency regression green; suite/lint/build green; compose + `pnpm smoke` green.
- [ ] DeterministicJudge rules documented in `design.md` (C8 script depends on them).
