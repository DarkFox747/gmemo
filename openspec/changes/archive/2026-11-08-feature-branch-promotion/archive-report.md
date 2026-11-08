# Archive Report: feature-branch-promotion

- **Date:** 2026-11-08 · branch `demo/e4`
- **Closes:** REPORTE-E4 §3 open divergence "promoción solo desde la rama por defecto" (HU-04.1); backlog follow-up 6.
- **Specs merged:** `openspec/specs/promotion/spec.md` — "OIDC fail-closed and default-branch enforcement" and "Composition root and workflow" replaced; HU-04.2 scenario "Merged path unchanged" replaced by "Merged path with a feature branch".
- **Behaviour:** `POST /promote` (merged) requires a token with `ref = refs/heads/<default>`, `event_name = push` and `job_workflow_ref = <repo>/.github/workflows/promote.yml@refs/heads/<default>`; a feature `source_branch` requires `pr_number` and its session is promoted with `origin_branch`/`origin_pr`. `promote.yml` resolves the merged PR from the pushed commit.
- **Demo:** `pnpm demo` promotes `feature/notif-async` directly (no re-propose workaround).
- **Numbers:** 1973 tests (+38), verify PASS in 2 rounds.
- **Follow-ups:** server-side PR verification via GitHub API; event/workflow binding for closed_unmerged.
