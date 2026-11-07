# Verify Report — write-path (write-to-staging slice)

schema: verify-report-v1
change: write-path
date: 2026-07-30
verdict: PASS (after remediation)

## Inputs
- Static security audit (crombie-security): **PASS** (0 CRITICAL / 0 HIGH).
- Static code review vs spec+design (crombie-reviewer): **FAIL** (1 HIGH).
- Run gate (crombie-worker, T033): **PASS** — build clean, 277 tests passed, 49 DB-gated skipped, 0 failed, lint clean.

## Verdict rule
FAIL on any CRITICAL/HIGH finding OR any failing test/build/lint. One HIGH present → **FAIL** (pending remediation).

## Findings

### HIGH
- **H1 (REQ-20) — `discard_staged` is not audited.** `src/mcp/tools/index.ts` (registerWriteTools)
  calls `recordWrite` only for `remember`; `discard_staged` (a destructive op) produces no
  `access_log` row. Spec REQ-20 requires auditing `remember` AND `discard_staged`; design
  Decision 6 deliberately excluded list/discard. **Resolution (orchestrator): implement audit for
  `discard_staged`** — satisfies the explicit acceptance criterion and is the secure-by-default
  choice for a destructive action. `recordWrite` will be generalized to carry a tool name and a
  discard-appropriate reference (no content_hash on a discard).

### MEDIUM (fold into remediation — cheap + security-relevant)
- **M1 — unbounded `fields` value → ReDoS/CPU-exhaustion.** `rememberInputShape.fields` is
  `z.record(z.unknown())` with no size cap; a contributor can send a large value that is
  `JSON.stringify`-ed and scanned by all secret regexes (near-O(n²) on crafted PEM-prefix input).
  Fix: bound `JSON.stringify(fields).length` (≤ 2000, mirroring body budget) in the handler →
  `INVALID_REFERENCE`; add a test.

### LOW (fold in — trivial correctness/robustness)
- **L1** — `discardStagedInputShape.item_id` → `z.string().uuid()` (avoid bad-UUID DB round-trips/noisy logs).
- **L2** — wrap `recordWrite` in its own try/catch: audit-write failure must NOT make a persisted
  stage appear failed to the caller (log server-side, return success).
- **L3** — guard the re-select in `findOrCreateOpenSession`: if the just-conflicted session was
  promoted/abandoned between INSERT and SELECT, `rows[0]` is undefined → throw
  `CONTEXT_UNAVAILABLE` instead of a TypeError.
- **L4** — hoist `WRITE_TOOLS`/`WRITE_ROLES` to module-scope consts (micro; design showed them module-scoped).
- **L5** — add a unit test for the secret-scan **internal-error** fail-closed branch (REQ-21 "OR a scan error").
- **L6 (docs)** — spec REQ-07 wording says `{ item_id, state }`; authoritative contract + code return
  `{ id, state }`. Fix spec wording (code is correct).

## Confirmed clean (both auditors)
RBAC atomic (widening + enforcement consistent; viewer denied on all write tools); tenant isolation
enforced at SQL layer (project+repo+branch+status join on list/discard/recall-mix); all SQL
parameterized; secret-scan before persist + fail-closed + category-only logging + hash-only audit;
error opacity (4 codes, no enumeration); ULID uses crypto randomness; 7/7 design decisions honored;
recall staged-mix first-page-only with main-only total_matches; DB-gated constraint tests assert
partial-unique index, op↔target/budget CHECKs, dup-hash, upsert-race idempotency.

## Remediation — DONE ✅ (2026-07-30)
One worker fixed H1 + M1 + L1..L5 with tests; L6 (spec wording) fixed by orchestrator inline.
- H1: `AuditLogger.recordWrite` generalized to `(ctx, {tool, sessionId?, itemId, contentHash?})`;
  `discard_staged` now audited (action='stage', tool in detail) — REQ-20 satisfied + tested.
- M1: `fields` JSON bounded to ≤ 2000 chars in the handler (before secret-scan) → INVALID_REFERENCE + test.
- L1: `discard_staged.item_id` → `z.string().uuid()`.
- L2: `recordWrite` calls wrapped in inner try/catch — audit failure logs server-side, does NOT fail the stage/discard.
- L3: `findOrCreateOpenSession` guards the conflict re-SELECT → CONTEXT_UNAVAILABLE on empty.
- L4: `WRITE_TOOLS`/`WRITE_ROLES` hoisted to module scope.
- L5: secret-scan internal-error fail-closed branch now unit-tested.
Files: src/mcp/context.ts, src/auth/auditLogger.ts, src/mcp/tools/index.ts, src/mcp/tools/remember.ts,
src/mcp/tools/schemas.ts, src/db/stagingRepository.ts, src/auth/authorizer.ts, + 4 test files.

## Final gate
`pnpm build && pnpm test -- --run && pnpm lint` → build clean, **285 tests passed**, 49 DB-gated
skipped, 0 failed, lint clean.

## FINAL VERDICT: PASS — 0 CRITICAL / 0 HIGH open. Ready to archive.
