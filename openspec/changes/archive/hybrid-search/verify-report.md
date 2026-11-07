# Verify Report — hybrid-search (two-phase)

schema: verify-report-v1
change: hybrid-search
date: 2026-07-31
verdict: PASS (after remediation)

## Inputs
- Static security audit (crombie-security): **PASS** (0 CRITICAL / 0 HIGH; 1 MEDIUM, 1 LOW).
- Static code review vs spec+design (crombie-reviewer): **FAIL** (1 HIGH; 3 LOW) — spec REQ-01..22 all met, 9/9 design decisions faithful.
- Run gate (worker T018): **PASS** — build clean, 413 tests, 89 DB-gated skipped, 0 failed, lint clean.

## Verdict rule
FAIL on any CRITICAL/HIGH. One HIGH → **FAIL** (pending remediation).

## Findings

### HIGH (fix now)
- **H1 (reviewer) — `let repo: any` in `tests/integration/hybridSearch.int.test.ts:65`** with an
  `eslint-disable no-explicit-any`. Defeats strict typing — a `recallSemantic` signature change wouldn't be
  caught. **Fix**: `import type { MemoryRepository }` + `let repo: MemoryRepository` (the dynamic
  `await import` is for the value `PgMemoryRepository`; the type imports statically).

### MEDIUM (fold in — real fail-soft gap)
- **M1 (security) — Phase-2 `recallSemantic` call not wrapped (`src/mcp/tools/recall.ts:64-75`).** The
  query-embed is try/caught, but the subsequent `recallSemantic` DB call is not → a Phase-2 throw (DB blip,
  0005 not applied, a future bad vector) turns a good BM25 response into a 500. Unreachable today (Bedrock
  deferred → embed throws first) but activates with the real embedder. **Fix**: wrap the Phase-2 block in its
  own try/catch → log warn, leave `semanticRecords` empty (BM25-only). Completes the fail-soft contract.

### LOW (fold in — cheap)
- **L1 (security) — `toVectorParam` doesn't reject non-finite** (`src/db/vector.ts`): a `NaN`/`Infinity`
  dimension would write a semantically-broken vector. **Fix**: `if (!vec.every(Number.isFinite)) return null;`
  (degrade to NULL — fail-soft). Not an injection (always bound `$N::vector`).
- **L2 (reviewer) — `SEMANTIC_FALLBACK_MIN_RESULTS` uses `.positive()` where the spec says `.min(1)`** —
  align to `.min(1)` for the exact contract wording. (Also apply to `_K` for consistency.)

### Not fixed (accepted / historical)
- LOW `UNIT_VEC` readonly nit (style, no behavior).
- Design doc File-Changes typo (`tests/memory/recallTwoPhase.test.ts` vs actual `tests/mcp/...`) — the CODE
  location is correct per project-map; design is historical, left as-is.
- Reviewer's suggested extra DB-gated end-to-end handler test — nice-to-have follow-up (REQ-20 covers
  `recallSemantic` directly; unit tests cover the handler orchestration).

## Confirmed clean (both auditors)
Injection: `toVectorParam` + `excludeIds` always bound (`$N::vector`, `$N::uuid[]`), never concatenated;
`content_tsv` never in a column list. Tenant isolation: `recallSemantic` scoped `project_id`+scope+status+
embedding-not-null, mirrors recall. Existing BM25 `recall` SQL/cursor/COUNT UNCHANGED. Write-time fail-soft
(embed error → NULL, promotion still succeeds); deprecate skips embed. Two-phase gate uses `total_matches < N`
+ first-page-only. Prod bypass impossible (superRefine + composition-root NODE_ENV double-check). No secret/PII
in logs. No `@aws-sdk` dep. HNSW partial-index predicate aligns with the query. Wiring flows via
`transport.ts` spread. 27→ REQ-01..22 satisfied.

## Remediation — DONE ✅ (2026-07-31)
One worker fixed H1 + M1 + L1 + L2 + a fail-soft test; gate re-run green.
- H1: integration test now uses a TYPE-ONLY `MemoryRepository` annotation (no `any`, no eslint-disable).
- M1: `recall.ts` wraps the Phase-2 `recallSemantic` call in its own try/catch → warn + BM25-only on failure
  (both the embed AND the vector call are now fail-soft; recall never 500s). + a test asserting a throwing
  `recallSemantic` returns BM25-only.
- L1: `toVectorParam` returns `null` when any dimension is non-finite (degrade to NULL).
- L2: `SEMANTIC_FALLBACK_MIN_RESULTS`/`_K` use `.min(1)` (spec wording); defaults 5/8 preserved.
Files: tests/integration/hybridSearch.int.test.ts, src/mcp/tools/recall.ts, src/db/vector.ts,
src/config/index.ts, tests/mcp/recallTwoPhase.test.ts.

## Final gate
`pnpm build && pnpm test -- --run && pnpm lint` → build clean, **416 tests passed**, 89 DB-gated skipped,
0 failed, lint clean.

## FINAL VERDICT: PASS — 0 CRITICAL / 0 HIGH open. Ready to archive.
