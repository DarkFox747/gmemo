# Archive Report: demo-baseline

**Archived**: 2026-11-07 | **Branch**: demo/e4 | **Final verdict**: PASS

## Shipped
- Sanitized repository (placeholders; local gitignored gate patterns) with a baseline commit on `main` that contains no sensitive history
- Product renamed LPMS → gmemo (code, seed, terraform `gmemo-pilot-*`, workflows `GMEMO_*`, docs, artefacts); predecessor and orchestrator-tool wording kept
- Bootable compose (pgvector, all dev stubs, loopback ports, db host 5433), `pnpm smoke` (7 steps), pnpm workspace with `@gmemo/web`
- Deterministic DB integration gate (555/555), rate-limit prod-guard test, dead scaffolding removed, DEVELOPMENT/README rewritten
- `openspec/specs/` baseline: 10 consolidated capability specs + `repository-hygiene`

## Specs synced
| Domain | Action | Details |
|--------|--------|---------|
| repository-hygiene | Created | Full spec copied from the change |
| dev-harness | Already merged | Delta requirements were folded into the consolidated spec by task 6.2 (`Source: demo-baseline`) |
| mcp-facade, auth, memory-read, staging, hybrid-search, promotion, bedrock-clients, http-security, infrastructure | Created | Consolidated from the 12 archived changes (task 6.2) |

## Retro
Signals recorded: 0 | baseline-excluded: 0 | malformed: 0

Metrics: verify rounds 1 | outliers 2 (apply: spec consolidation worker, verify-run worker)

| Lesson | Scope | Area | Hits | Status | Pitfall | Check |
|--------|-------|------|------|--------|---------|-------|

### Pending promotion
None

## Follow-ups
- R1-CR1: `.env.dev.example` must be updated by the human (gmemo credentials, port 5433, gmemo-demo remote, `EMBEDDER_STUB=true`; C1 also removes `JUDGE_STUB_VERDICT`). The user accidentally edited `.env.example`, which must be reverted or confirmed.
- R1-CR6: FK `ON DELETE SET NULL` on `staging_item.target_memory_id` vs `ck_item_optarget` (schema debt)
- GitHub repository variables → `GMEMO_*`; `vars.AWS_ROLE_ARN` → renamed role (out-of-band, before any deploy)
- PNG diagrams in `docs/artefactos/` need a manual review for embedded identifiers
- Re-run `/sdd-init` to refresh `openspec/project-map.yaml` (area context, staleness anchor)
