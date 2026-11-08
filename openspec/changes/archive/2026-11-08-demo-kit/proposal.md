# Proposal: demo-kit (C8) — seed, E2E script, metrics, instructions and package

## Intent
Make the TFG demo reproducible from scratch: realistic seed data, a scripted end-to-end walkthrough that doubles as an E2E test, synthetic retrieval/judge metrics (TT-06), Spanish instructions, an optional real-agent config, optional screenshots, and a sanitized zip package.

## Scope

### In Scope
1. **Demo seed** (dev-only, guarded against production, idempotent, fixed UUIDs; extends `migrations/seed.dev.sql`):
   - Rename the seeded project to "Portal de Clientes" (keep repo `crombie-llc/gmemo-demo` so smoke and dev OIDC still work) and add a second repo `crombie-llc/portal-clientes-api`.
   - Users `tl@demo.local` (project_admin), `dev@demo.local` (contributor), `viewer@demo.local` (viewer) already exist from C2. Add a `service_agent` machine credential for the second repo.
   - About 15 active memories covering the 7 types, with versions and history (memory_revision rows) and `revalidate_at` set; 2 with an expired `revalidate_at`.
   - Review queue: 2 uncertain (contradiction, grounding) and 2 mandatory-review items in a closed session.
   - Quarantine: one entry per reason code (secret_detected redacted, embedded_instructions, duplicate_content, judge_rejected, human_rejected).
   - Memory content in English (FTS `english`); visible names may be Spanish.
2. **E2E script** `scripts/demo-e2e.ts` (`pnpm demo`), readable step output against the compose stack, exit 0 only if every expectation holds:
   1. As `dev`, `remember` on branch `feature/notif-async`: a valid gotcha, a decision contradicting an active one, an item with embedded instructions, a duplicate; plus an item with a credential that is rejected at capture (HU-03.4).
   2. `list_staged` and `recall` show the drafts.
   3. `POST /promote` for the feature branch's merge (dev OIDC bypass) → summary (applied, uncertain, quarantined).
   4. As `tl`: list the queue, approve the decision marking the old one superseded, restore a quarantine entry, run the revalidation job.
   5. Final `recall`: the new memory appears; the superseded and the pending ones do not.
   - The `/promote` merge path requires the default branch, so the script promotes the session the way the real flow does. Documented in the design notes of tasks.
3. **Real agent (optional)**: `docs/demo/mcp-local.example.json` (Claude Code MCP config pointing to `http://localhost:3000/mcp` with the seed headers) plus an example prompt.
4. **Metrics (TT-06)**: `scripts/eval.ts` (`pnpm eval`) with versioned fixtures (`eval/fixtures/*.json`: ~20 labelled units, 15 queries with relevance). Computes recall@5, MRR and nDCG@5 for the RRF recall, and judge false-positive/false-negative rates (DeterministicJudge). Writes `docs/demo/metricas.md`, stating it uses synthetic data and stubs.
5. **Screenshots (if Playwright is available)**: `scripts/screenshots.ts` → `docs/demo/capturas/*.png` (1440×900, deviceScaleFactor 2), five screens. Skipped with a clear message if Playwright or the web build is absent.
6. **Instructions** `docs/demo/INSTRUCTIVO.md` (Spanish):
   - what the demo is; requirements; start in 2 commands; URLs; dev users and role switching;
   - step-by-step script (web + `pnpm demo`); connecting a real agent; tests and metrics;
   - HU → endpoint/tool/screen table; simplifications vs the AWS architecture; troubleshooting (ports, `down -v`).
7. **Package**: `scripts/package-demo.sh` → `dist-demo/gmemo-demo.zip`.
   - Excludes `node_modules`, `.git`, `.claude`, `.mcp.json`, `CLAUDE.md`, `entrevistas`, prompt files, `.sanitize-patterns`, `dist`, `*.tfvars`, `*.tfstate*`, `.terraform/`, `.env` (keeps `*.example`).
   - Includes `openspec/` and `docs/demo/`.
   - Ends with the sanitization grep over the unzipped copy.

### Out of Scope
Deployment to AWS, Cognito login, SES, real Bedrock quality metrics.

## Decisions
- D1: the design phase is skipped (scripts, data and docs following existing patterns); tasks reference proposal sections.
- D2: the E2E script uses only HTTP (MCP JSON-RPC as in `scripts/smoke.ts`, REST `/api/v1`, `/promote`, `/internal/jobs`), no DB access.
- D3: the eval runs in-process over the real `fuseRrf`/DeterministicJudge with an in-memory corpus (no DB), so it is deterministic and fast.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Seed conflicts with existing seed rows | Med | Fixed UUIDs, ON CONFLICT DO NOTHING/UPDATE; smoke + DB gate |
| E2E flakiness from rate limits | Low | Stay under limits; sequential |
| Zip leaks sensitive files | Low | Exclusion list + grep gate on the unzipped copy |

## Rollback Plan
Revert the commit (seed and scripts only).

## Success Criteria
- [ ] `docker compose down -v && docker compose up --build` + `pnpm demo` green from scratch; `pnpm eval` writes metrics; zip generated and verified; instructions complete.
