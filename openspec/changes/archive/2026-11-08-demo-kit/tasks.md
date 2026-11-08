# Tasks: demo-kit (C8)

> Design skipped (D1). Specs: `specs/demo-kit/spec.md`. TDD where testable (seed integrity, metric functions, zip exclusion).

- [x] 1.1 Demo seed: extend `migrations/seed.dev.sql` per proposal §1 (project rename, second repo, machine credential, ~15 memories with revisions and deadlines, 2 expired, 4 queued items, 5 quarantine entries); DB-gated test `tests/db/seedDemo.integration.test.ts` asserting the counts and that smoke still passes
- [x] 1.2 Metrics: `eval/fixtures/corpus.json`, `eval/fixtures/queries.json`, `eval/fixtures/judge.json`, pure metric functions `scripts/lib/metrics.ts` (recall@k, MRR, nDCG@k, FP/FN rates) with tests `tests/eval/metrics.test.ts`, `scripts/eval.ts` (`pnpm eval`) writing `docs/demo/metricas.md`
- [x] 2.1 E2E script `scripts/demo-e2e.ts` (`pnpm demo`) per proposal §2, run twice against a fresh compose (both exit 0)
- [x] 2.2 Real agent: `docs/demo/mcp-local.example.json` + example prompt in the instructions
- [x] 2.3 Screenshots: `scripts/screenshots.ts` (skips cleanly if Playwright or the web build is missing)
- [x] 3.1 Instructions `docs/demo/INSTRUCTIVO.md` per proposal §6
- [x] 3.2 Package `scripts/package-demo.sh` → `dist-demo/gmemo-demo.zip` with exclusions and the grep gate; `pnpm package:demo`
- [x] 4.1 Gate: suite + DB gate, lint, build, `docker compose down -v && up --build`, `pnpm smoke`, `pnpm demo`, `pnpm eval`, package + grep

## Phase 5: Verify remediation

- [x] 5.1 Package gate fails closed without patterns (ALLOW_NO_PATTERNS=1 override); key-material and agent-tooling exclusions
- [x] 5.2 Root README rewritten for the TFG presentation
