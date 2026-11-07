# Verify Report: judge-structured-verdict

## Round 1

**Round 1 Verdict: PASS**

Tasks: 8/8 complete at round start (1.1–4.1).

---

## Spec Compliance (crombie-reviewer-high)

All scenarios of `specs/promotion` (structured verdict, HU-06.1–6, pipeline HU-05 ×3, previously-uncertain sanitized, notifier no content, stale → queue, judge config, idempotency), `specs/staging` (stale at capture, dedup no re-notify) and `specs/dev-harness` (compose without `JUDGE_STUB_VERDICT`, smoke still promotes) are COMPLIANT, with tests in `tests/promote/promoteVerdict.test.ts`, `tests/promote/{sanitize,routing}.test.ts`, `tests/judge/*`, `tests/security/*`, `tests/staging/remember.test.ts`, `tests/config/judgeConfig.test.ts`, and gate 4.1 (compose + smoke ×2 + 10 e2e judge triggers, all matched).

Compliance summary: 21/21 scenarios compliant (structured-verdict rejected-path justification PARTIAL → fixed in round 2).

---

## Code Review (crombie-reviewer-high)

Reviewer verdict: APPROVE_WITH_COMMENTS
- R1-CR1 MEDIUM `src/db/promotionRepository.ts` — judge justification dropped for R3/R4 quarantines → persist `decision.reason`
- R1-CR2 MEDIUM — no DB assertion that the staging row is masked after `hash_conflict`
- R1-CR3 LOW `src/config/index.ts` — unit interval without `.trim()`
- R1-CR4 LOW `src/promote/sanitize.ts` — injection scan over `JSON.stringify(fields)` misses `\n`-split phrases
- R1-CR5/6/7 LOW — `.env.example` mentions `JUDGE_STUB_VERDICT`; DNI false positives; rule-5 artefact regex lenient (dev only)
- Pre-existing: terminal status counts skipped items; finalized sessions never re-drive queued items (by design until C2)

## Security Audit (crombie-security-high)

Security verdict: FINDINGS
- R1-SEC1 MEDIUM — mandatory-review bypass: `amend` changing the target memory type
- R1-SEC2 MEDIUM — injection/secret scans evadable with zero-width/format chars
- R1-SEC3 MEDIUM `MARK_QUARANTINED_SQL` — no `promoted_at`/`reviewed_at` guard while overwriting content
- R1-SEC4 LOW per-item failure aborts the whole promotion · R1-SEC5 LOW masked fields can exceed budget · R1-SEC6 LOW threshold 0 / empty mandatory list allowed in production · R1-SEC7 LOW ASCII-only context tokenisation · R1-SEC8 LOW model reason stored verbatim (web must escape) · R1-SEC9 LOW PII coverage limits · R1-SEC10 LOW secret-bearing content hash kept on redacted rows · R1-SEC11 LOW no per-session item cap · R1-SEC12 LOW `list_staged` oracle for mandatory items · R1-SEC13 LOW quadratic `\s*\/?\s*` (bounded)

## Test / Build / Lint (crombie-worker, gate 4.1)
`pnpm test -- --run` 734 passed / 106 skipped · lint 0 · build 0 · compose up healthy · `pnpm smoke` ×2 exit 0 · e2e 10/10 judge outcomes as designed (logs: `review_enqueued`/`leak_detected`, no content) · DB gate 840/840.

### Area context (area-lint)
Skipped: `.claude/rules/tests.md` targets node:test; the project convention (Vitest/pnpm) wins.

---

## Round 2 (after task 5.1 remediation)

**Round 2 Verdict: PASS**

Evidence: `pnpm test -- --run` 771 passed / 115 skipped; DB gate 886/886; lint 0; build 0; compose + `pnpm smoke` exit 0. New tests: `tests/promote/promoteRemediation.test.ts`, `tests/db/toOrQuery.test.ts`, extended sanitize/routing/remember/listStaged/judgeConfig/promotion.integration.

### Carried findings

| ID | Status |
|----|--------|
| R1-CR1 | RESOLVED (judge justification on staging; code on quarantine) |
| R1-CR2 | RESOLVED (DB test after hash_conflict) |
| R1-CR3 | RESOLVED (trim) |
| R1-CR4 | RESOLVED (string-leaf injection scan) |
| R1-CR5 | OPEN (human edits `.env*`) |
| R1-CR6 | OPEN (accepted heuristic) |
| R1-CR7 | OPEN (dev-only) |
| R1-SEC1 | RESOLVED (capture rejects type change; apply-time `review_required`; routing uses target type) |
| R1-SEC2 | RESOLVED (NFKC + strip `\p{Cf}` scan copy) |
| R1-SEC3 | RESOLVED (guards + rollback on 0 rows) |
| R1-SEC4 | RESOLVED (per-item isolation) |
| R1-SEC5 | RESOLVED (fail closed) |
| R1-SEC6 | RESOLVED (production floors) |
| R1-SEC7 | RESOLVED (Unicode tokens) |
| R1-SEC8 | OPEN → C7 must HTML-escape (React default) |
| R1-SEC9 | OPEN (documented limits) |
| R1-SEC10 | RESOLVED (redacted hash) |
| R1-SEC11 | OPEN (follow-up) |
| R1-SEC12 | RESOLVED (`list_staged` shows uncertain) |
| R1-SEC13 | OPEN (bounded, negligible) |

---

## Deviations from Design (context only)
See `apply-progress.md` (batches 1–2 and remediation): `normalizeJudgeResult` 3rd arg; detectors' 10k backstop; supersede/deprecate never embedded at promotion; `applyAccepted(…, mandatoryTypes)` + `review_required`; `target_type` on promotable rows.

## Strengths ✅
A single fail-closed trust boundary for every judge output; pure routing and sanitize tables mapped one-to-one to tests; content-free notifier proven by tests; e2e coverage of every deterministic judge outcome; additive idempotent migration.

---

# Final Verdict

**Verdict: PASS**

| ID | Severity | Status |
|----|----------|--------|
| R1-CR5 | LOW | OPEN |
| R1-CR6 | LOW | OPEN |
| R1-CR7 | LOW | OPEN |
| R1-SEC8 | LOW | OPEN |
| R1-SEC9 | LOW | OPEN |
| R1-SEC11 | LOW | OPEN |
| R1-SEC13 | LOW | OPEN |
