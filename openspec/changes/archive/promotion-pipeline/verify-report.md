# Verify Report — promotion-pipeline

schema: verify-report-v1
change: promotion-pipeline
date: 2026-07-31
verdict: PASS (after remediation)

## Inputs
- Static security audit (crombie-security): **FAIL** (1 HIGH, 1 MEDIUM, 4 LOW).
- Static code review vs spec+design (crombie-reviewer): **PASS** (0 CRITICAL/HIGH; 1 MEDIUM, 4 LOW).
- Run gate (worker T024): **PASS** — build clean, 358 tests, 83 DB-gated skipped, 0 failed, lint clean.

## Verdict rule
FAIL on any CRITICAL/HIGH. One HIGH → **FAIL** (pending remediation).

## Findings

### HIGH (fix now)
- **H1 (A01) — OIDC `ref` claim never enforced.** `src/http/promote.ts` extracts `principal.ref`
  but never uses it; `TenantContext.branch` comes solely from client-controlled `body.source_branch`.
  A machine credential can target ANY branch's staging session. **Fix**: after OIDC verify, assert
  canonicalized `principal.ref` (`replace(/^refs\/heads\//,'')`) === `body.source_branch` → else opaque
  `PERMISSION_DENIED`. (Dev seed uses ref `refs/heads/main` + session on `main`, so the demo still works.)

### MEDIUM (fold into remediation)
- **M1 (A02, security) — promotion secret-scan omits `item.fields`.** `promoteService` calls
  `assertNoSecrets(title, summary, body)` but not `JSON.stringify(item.fields)` — the write tool does.
  The promotion gate is the LAST barrier before authoritative `memory`; must be ≥ as thorough. **Fix**:
  add `JSON.stringify(item.fields)` as the 4th arg.
- **M2 (reviewer) — `authorizePromote` deny path untested.** The machine-credential refusal
  (absent/revoked/expired/wrong-role → `PERMISSION_DENIED`) is only covered via the fake. **Fix**: add a
  unit test on `RdsAuthorizer.authorizePromote` over `InMemoryAuthRepository` (deny cases) + an HTTP case.

### LOW (fold in — cheap security/correctness)
- **L1 — self-supersede `23514`**: if a supersede item's content_hash equals its target's, dedup yields
  `newMemoryId === target_memory_id` → `memory_relation` `from==to` violates `CHECK (from<>to)` (23514),
  uncaught → opaque 500. **Fix**: short-circuit when `newMemoryId === target_memory_id` (or catch 23514 → quarantine `duplicate_content`).
- **L2 — `recordVerdict` not atomic with quarantine (rejected path)**: a rejected item is marked
  `judge_state='rejected'` before `quarantineItem`'s own txn; if quarantine fails, the item is skipped
  forever with no quarantine row. **Fix**: drop the pre-quarantine `recordVerdict` for the rejected
  branch; rely on `quarantineItem`'s in-txn `MARK_QUARANTINED_SQL`.
- **L3 — apply-time tenant re-assertion (defense-in-depth)**: amend/supersede/deprecate lock+mutate the
  target `memory` by `id` alone. **Fix**: add `AND project_id = $N` (ctx.projectId) to the target
  lock/update; and JOIN `staging_session` in `fetchPromotableItems` to re-assert `project_id`.
- **L4 (deferred, NOT fixed now) — no rate limit on `/promote`.** Needs `express-rate-limit` (a new dep,
  already backlogged as M-02). Left deferred; noted in backlog.

## Confirmed clean (both auditors)
Tenant scoping in every write; token `repository` claim authoritative over `body.repo`; authz chain
unskippable (no promote() without authorizePromote); all SQL parameterized; `content_tsv` never in a
column list; BedrockJudge fail-closed (error→uncertain, never accepted); stale/duplicate never silently
applied; per-item `FOR UPDATE` + `promoted_at IS NULL` first-writer-wins (no double-apply); config
superRefine + composition-root `NODE_ENV!=='production'` double-guard on both stubs; error opacity
tested (no body/tenant/stack leak); secret-path quarantine redacted; recordPromote logs no raw content;
no `@aws-sdk` dep; 27/27 REQ + 8/8 design decisions honored.

## Remediation — DONE ✅ (2026-07-31)
One worker fixed H1 + M1 + M2 + L1 + L2 + L3 with tests; gate re-run green.
- H1: `src/http/promote.ts` now canonicalizes `principal.ref` (strips `refs/heads/`) and asserts it
  equals `body.source_branch` → opaque `PERMISSION_DENIED` on mismatch (+ supertest case).
- M1: `promoteService` sanitize now includes `JSON.stringify(item.fields ?? {})` (+ fields-only-secret test).
- M2: new `tests/auth/authorizePromote.test.ts` (active→ActorIdentity; absent/revoked/expired/wrong-role
  → PERMISSION_DENIED) + an HTTP authorizer-deny case.
- L1: supersede short-circuits when deduped `newMemoryId === target_memory_id` (avoids `CHECK from<>to` 23514).
- L2: rejected branch no longer pre-calls `recordVerdict`; `quarantineItem`'s in-txn mark makes the
  transition atomic.
- L3: apply-time `AND project_id = $N` re-assertion on amend/supersede/deprecate target lock/update +
  `fetchPromotableItems` JOINs `staging_session` on `project_id` (defense-in-depth tenant barrier).
Files: src/http/promote.ts, src/promote/promoteService.ts, src/db/promotionRepository.ts,
tests/http/promote.test.ts, tests/promote/promoteService.test.ts, tests/auth/fakes.ts, tests/auth/authorizePromote.test.ts.
L4 (rate limit) stays DEFERRED → backlog M-02 (needs express-rate-limit dep).

## Final gate
`pnpm build && pnpm test -- --run && pnpm lint` → build clean, **371 tests passed**, 83 DB-gated
skipped, 0 failed, lint clean.

## FINAL VERDICT: PASS — 0 CRITICAL / 0 HIGH open. Ready to archive.
