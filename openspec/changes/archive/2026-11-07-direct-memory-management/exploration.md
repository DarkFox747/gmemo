# Exploration: direct-memory-management (C5)

One crombie-explore scope (direct write entry into the pipeline). Status: COMPLETE.

- The pipeline is **row-coupled**: persistMasked, recordDecision, quarantineItem and applyAccepted all address a `staging_item` id (`LOCK_ITEM_SQL`, `MARK_APPLIED_SQL`, `src/db/promotionRepository.ts:227-229, 351-355`). The cheapest single-write-path fit is a **one-item staging session per web write** (branch `web/<userId>`; `ux_session_open` cannot collide with git branches; `/promote` only handles the default branch), run through C3's planned `PromoteService.promoteItem` with C2's `applyOpInTxn` core.
- `memory.provenance` is hardcoded `pr_reviewed` in INSERT and amend (`:241, :281`). `web_ui` arrives in C4 migration 0009, so provenance must become a parameter.
- `memory.repo_id`/`origin_branch`/`origin_pr` are nullable, but `staging_session.repo_id` is NOT NULL, so a web write needs a repo (pick one of the project's).
- **HU-13.1 vs routing R7**: decision/constraint/domain_rule (and supersede/deprecate) always queue. A direct confirm by the project_admin needs an explicit human-approval path that sets `approved_by`.
- **Stale**: apply returns `stale` → PromoteService queues it (HU-11.3). A direct PUT must surface 409 instead.
- **Preview** is mostly pure: `sanitizeItem`, `routeDecision`, `normalizeJudgeResult` + read-only `findJudgeContext` + `judge.evaluate`. `judgeItem` is private and must be extracted.
- `memory_revision` (revision_no, op, snapshot, author, promoted_from_item nullable, created_at) has no project_id, so the tenant check joins memory. It is not read anywhere today.
- The list needs its own query (status filter, optional q via `websearch_to_tsquery`, pagination). `content_tsv` is generated.
- Field validation: `assertValidFields` (`src/mcp/fieldsPolicy.ts`) is not re-run by the pipeline, so the direct path must call it.
- Secrets: `remember` hard-rejects; only the pipeline quarantines + leak notifies (HU-13.4 wants the pipeline behaviour).
- An amend with a null embedding (fail-soft) overwrites the vector; acceptable but documented.
- Observed mid-flight: a C1 remediation worker was changing the `applyAccepted` signature (4th param) at exploration time. Re-verify after it lands.
