# Proposal: quarantine-management (C3) — HU-10

## Intent
The TFG requires the quarantine to keep span-redacted content, the reason criterion, a restore path that re-runs the pipeline and judge (recorded as a label to measure the judge), retention with periodic purge (60 days, configurable), and access limited to the tech lead or the author. Today the quarantine redacts whole fields, has no criterion, no restore and no expiry. This closes divergence 5.

## Scope

### In Scope
1. **Migration 0008** (idempotent):
   - quarantine `criterion` (`pipeline|judge|human_review`), `reason_code` (`secret_detected|embedded_instructions|duplicate_content|judge_rejected|human_rejected|sanitize_failed`), `related_memory_id` FK SET NULL, `restored_by` FK app_user, `restored_at`, `restored_item_id`.
   - Backfill mapping: sanitize reasons → pipeline; `security_second_layer` → judge/secret_detected; `specificity` and other judge reasons → judge/judge_rejected; `duplicate_content` → judge if the item's criterion was duplication, else pipeline; `human_review:%` → human_review/human_rejected.
   - `expires_at` backfilled (`quarantined_at + 60 days`); index for the list query.
2. **Every quarantine insert** sets criterion, reason_code, related_memory_id and `expires_at = now() + QUARANTINE_RETENTION_DAYS` (default 60, validated).
3. **Span redaction**:
   - `scanForSecretsWithRanges` (`g` + `matchAll`); PEM ranges extend to the END line; value-only assignments; merged ranges.
   - Spans replaced by `[REDACTADO]`, title/summary/body clamped to the CHECK limits (fall back to whole-field redaction if a clamp would split a sentinel).
   - Fields redacted per string leaf.
   - Applied to quarantine and staging_item.
   - Explicit test: the secret never appears in any table (`information_schema` scan of text/jsonb columns).
4. **API** (`/api/v1`, C2 middleware):
   - `GET /projects/:projectId/quarantine?reason=` → id, reason_code, criterion, unit type and title, excerpt (≤160 chars of redacted body), quarantined_at, days until expiry.
   - `GET …/quarantine/:id` → redacted detail plus related memory ref.
   - `POST …/quarantine/:id/restore` → creates a staging_item in session `restore/<id>` (original repo and author; branch label from the origin session), runs the **same** sanitize, judge, route and apply pipeline immediately, records `restored_by`/`restored_at`/`restored_item_id`, and returns `{outcome: applied|queued|quarantined, memoryId?|itemId?|quarantineId?}`.
   - Access: project_admin of the project **or** the author (`author_identity = principal.subject`) for GET; restore is project_admin only. Everyone else gets the uniform 404.
5. **Jobs** (shared with C4):
   - `/internal/jobs/*` router, enabled in development or when `JOBS_TOKEN` is set. Bearer token compared in constant time. Opaque 404 when disabled.
   - `POST /internal/jobs/quarantine-purge` deletes rows with `expires_at < now()`, returns the count and is audited.
   - Script `pnpm job:quarantine-purge` (tsx, calls the same service). EventBridge Scheduler documented, not implemented.

### Out of Scope
Memory lifecycle (C4), web UI (C7), SES.

## Decisions (auto mode)
- D1: the reason_code enum is extended with `sanitize_failed` (honest label); fine-grained judge reasons stay in `judge_reason`.
- D2: a restored item keeps the original author; the restorer is recorded in `restored_by`; restoration counts as a judge-measurement label (`restored_at IS NOT NULL` = false-positive candidate).
- D3: restore of a quarantine whose repo was deleted → 404 (cannot open a session).
- D4: a single `JobsService` + router introduced here; C4 adds the revalidation job to it.

## Affected Areas
`migrations/`, `src/security/secretScan.ts`, `src/db/promotionRepository.ts` (+ new `quarantineRepository.ts`), `src/promote/*` (restore entry point), `src/quarantine/` (service), `src/http/api/*`, `src/http/jobs.ts`, `src/config`, `src/index.ts`, `scripts/`, `package.json`, tests, docs.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Span redaction leaves secret fragments | Med | PEM end-extension, merged ranges, never-persisted test across all tables |
| Sentinel overflow of CHECK limits | Med | Clamp + fallback; tests |
| Restore bypasses the pipeline | Low | Same service entry point; integration test |
| Job endpoint exposed | Med | Disabled unless dev or token; constant-time compare; prod guard test |

## Rollback Plan
Revert the commit. 0008 is additive (nullable columns + backfill), so old code ignores it.

## Success Criteria
- [ ] HU-10.1–4 tests (view redacted + reason; restore re-runs pipeline/judge and records the label; purge deletes expired; foreign user denied).
- [ ] Secret-never-persisted test across all tables; suite, DB gate, lint, build, compose and smoke green.
