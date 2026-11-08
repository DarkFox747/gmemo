# Tasks: CI test gate and security follow-ups

## Design note (2.x — atomic API audit)

- **Seam:** `TxnAudit<R> = (db, result) => Promise<void>` (`src/db/authRepository.ts`): a hook a repository write runs on **its own transaction client after the data change and before COMMIT**; a throw rolls the write back. `insertAccessLog(entry, db?)` takes the transaction client. `AuditLogger.apiWriteAudit(actor, project, action)` binds actor/project/action and returns an `ApiWriteAudit` that inserts **the same row as `recordApi`** (shared `apiAccessLogEntry` builder: same allow-list, action `update`, `detail.api`, `userId`).
- **Flow:** route binds the hook → service maps the committed repo result to the same `ApiAuditDetail` the route used before → repository runs it inside its existing transaction. No ambient/implicit transaction, no new layer; the write paths stay where they were.
- **Per write kind:** review approve/reject → `approveReviewItem` / `rejectReviewItem` txn (around `applyOpInTxn` / `insertQuarantineSnapshot`); lifecycle confirm/retire/retire-by-pr → their single statement now runs in a BEGIN…COMMIT with the hook (only when a hook is given); direct create/amend and quarantine restore → `PromoteItemOptions.audit` threads to the item's terminal write (`applyAccepted`, `quarantineItem`, or the terminal `recordDecision`), which runs the hook in that write's transaction (`ItemWrite` facts: outcome + ids + post-apply memory status).
- **Semantics kept:** only writes are audited (not_found / invalid / conflict / unavailable never run the hook); a direct dedup onto a non-active memory (409 `duplicate_inactive`) is still not audited; reads keep the post-success `recordApi`. Repository hooks are optional (promotion pipeline, jobs and repo-level tests unchanged); services require them.
- **Bounded by design (not a hack, not a refactor):** the restore **claim** and the direct-write **session insert** are separate earlier transactions, unchanged. A pipeline/audit failure after the claim is compensated by an un-claim (4.3: session abandoned + `restored_*` cleared in one statement, only while the item is untouched); after the session insert it leaves an abandoned web session — never a committed memory or quarantine write without its audit row.

## Phase 1: Secret detectors (TDD)
- [x] 1.1 Tests first (`tests/security/*`, fixtures built at runtime in `tests/security/secretFixtures.ts`): detect + redact span for `openai_project_key`, `github_fine_grained_pat`, `aws_secret_access_key`; benign 40-char hash not flagged; capture rejection (`tests/staging` or `tests/mcp` remember) for a fine-grained PAT.
- [x] 1.2 `src/security/secretScan.ts`: add the three entries (pattern + global range) consistent with existing ones; keep fail-closed and category-only logging.

## Phase 2: Atomic API audit
- [x] 2.1 Map every REST write path that calls `auditLogger.recordApi` after the data change (review, quarantine restore, lifecycle, direct memory) and the transaction each write uses.
- [x] 2.2 Write the audit row inside that transaction (same row shape/action); audit failure → rollback → opaque error. Keep reads' audit behaviour unchanged.
- [x] 2.3 DB integration tests: write + audit row committed together for each write kind; injected audit failure rolls back (at least retire, approve, direct create).

## Phase 3: CI
- [x] 3.1 `.github/workflows/ci.yml` per proposal (pinned SHAs, `permissions: contents: read`, pgvector service with healthcheck, corepack pnpm, frozen install, lint, build, typecheck:web, build:web, `pnpm test -- --run` with DATABASE_URL). Validate YAML parses.
- [x] 3.2 README: CI badge placeholder-free mention (no repo URL assumptions) or a short "CI" note; backlog follow-ups #2 and #3 marked done.

## Phase 4: Verify remediation (round 1)
- [x] 4.1 (security MEDIUM) AWS secret detector: widen keyword to `aws[_\- ]?secret(?:[_\- ]?access)?[_\- ]?key|secretAccessKey` (case-insensitive), allow whitespace as separator (`[=:]` or spaces, optional quotes); align pattern and range (same separators); when `aws_access_key_id` is detected in a unit, any bare 40-char `[A-Za-z0-9/+]{40}` token in that unit counts as a secret (isSecretFree fails → whole-item redaction). Tests: each new form, the AKIA + bare-secret pair, no FP on bare hashes without AKIA.
- [x] 4.2 (security MEDIUM) Generalize sk- key families: detect `sk-<2..10 letters>-<20+ [A-Za-z0-9_-]>` (covers proj, svcacct, admin, ant, or, None) with range; keep `openai_api_key`. Runtime-built fixtures incl. an Anthropic-style key.
- [x] 4.3 (reviewer MEDIUM) Restore failure after claim: un-claim — in the same failure handling, abandon the `restore/<id>` session and clear the claim labels (`restored_by/at/item_id`) so a retry works (closes backlog E4 #1); test with an audit failure and a pipeline failure.
- [x] 4.4 (reviewer MEDIUM) DB tests in `tests/db/apiAuditAtomic.integration.test.ts`: direct amend (success + rollback), restore ending in quarantine (success + rollback), single audit row on the apply path.
- [x] 4.5 (LOW) Replace variable-length lookbehinds in range regexes (AWS + `secret_assignment`) with capture-group span computation; strip extra invisible chars in `normalizeForScan` (`\u034F\u115F\u1160\u3164\u2800\uFE00-\uFE0F`); `src/http/api/errorHandler.ts` logs error name/code only (no pg detail); ci.yml test step `pnpm exec vitest run`; tidy `SELECT_MEMORY_STATUS_SQL` placement and replace non-null assertions with typed guards.
