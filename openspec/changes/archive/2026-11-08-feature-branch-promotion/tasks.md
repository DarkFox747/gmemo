# Tasks: Feature-branch promotion bound to the merged PR

> No design.md: single-module change; tasks derive from the proposal and the promotion delta spec.

## Phase 1: Handler and dev stub

- [x] 1.1 `src/http/promote.ts` merged path: replace Step 3.5 + Step 4a with: resolve repo (Step 4) first, then require `principal.ref === 'refs/heads/' + repoResolution.defaultBranch`; if `body.source_branch !== defaultBranch` require `body.pr_number !== undefined`; every failure → `PERMISSION_DENIED`. Tenant branch, `originBranch` = `body.source_branch`, `originPr` = `body.pr_number ?? null`. Update the header comment chain.
- [x] 1.2 `src/http/promote.ts`: pass `devRef: 'refs/heads/' + source_branch` to `oidcVerifier.verify` only when `event === 'closed_unmerged'`; merged event passes no devRef (stub default `refs/heads/main` = seeded default branch). Update the doc comment in `src/auth/devOidcAuthenticator.ts` accordingly (no behaviour change there).

## Phase 2: Tests

- [x] 2.1 `tests/http/promote.test.ts`: cover every scenario of the delta spec — feature source + pr_number + default-branch token → promote called with feature tenant branch, originBranch and originPr; feature source without pr_number → denied; token ref feature branch or `refs/pull/7/merge` → denied (merged event, both default and feature source); default branch with/without pr_number unchanged; replace the old "feature branch denied" expectation. Keep closed_unmerged tests green (stub ref still bound to source branch).
- [x] 2.2 DB integration (`tests/db/promotion.integration.test.ts` or the existing promote integration file): feature session promoted end to end via the handler or service with `origin_branch = feature/x`, `origin_pr = 7`; second identical call → `no_op`.

## Phase 3: Workflow, demo and docs

- [x] 3.1 `.github/workflows/promote.yml` push job: add `pull-requests: read`; a step that calls `gh api repos/$GH_REPOSITORY/commits/$GH_SHA/pulls` (GITHUB_TOKEN via env) and selects exactly one PR with `merged_at != null`, `base.ref == default branch`, `head.repo.full_name == github.repository`; output head ref + number; the POST step builds the body with `jq --arg/--argjson` (feature + pr_number when found, else default branch + merge_sha). Update the header security notes.
- [x] 3.2 `scripts/demo-e2e.ts` step 4: drop the re-propose-on-main workaround; show that `/promote` for `feature/notif-async` without `pr_number` is refused, then promote `feature/notif-async` with `PR_NUMBER` and keep all later checks (applied/uncertain/quarantined, origin PR used by later steps). Update the file header comment. `scripts/smoke.ts` unchanged unless it breaks.
- [x] 3.3 Docs: `docs/demo/INSTRUCTIVO.md` §6.1 table row 4 and §6.2 (feature promoted directly, how the workflow finds the PR), §7 agent section (feature branch now promotable); `docs/demo/REPORTE-E4.md` §3 (move to resolved) and HU-04.1 row; `README.md` if it mentions the limitation; `docs/artefactos/gmemo_facade_contract_v1.md` if it documents the `/promote` branch rule.

## Phase 4: Verify remediation

- [x] 4.1 `src/auth/oidcAuthenticator.ts`: extract the verified `event_name` and `job_workflow_ref` claims into `PromotePrincipal` (`eventName`, `jobWorkflowRef`, null when absent/empty). Update the dev stub (`eventName: 'push'`, `jobWorkflowRef` = promote.yml on `refs/heads/main` of the fixed repository) and every test fake.
- [x] 4.2 `src/http/promote.ts` merged path: additionally require `principal.eventName === 'push'` and `principal.jobWorkflowRef === '<repository>/.github/workflows/promote.yml@refs/heads/<default>'`; any mismatch/null → opaque `PERMISSION_DENIED`. closed_unmerged unchanged.
- [x] 4.3 Tests: default-branch token with event `pull_request_target`/`workflow_dispatch`/`schedule`/null, or job_workflow_ref from another file/ref/repository/null → denied; happy paths green; oidcAuthenticator extracts the claims (absent → null); real verifier ignores `opts.devRef` (already covered).
- [x] 4.4 `.github/workflows/promote.yml`: PR selection also requires `.merge_commit_sha == $sha`; the zero-or-many path emits `::warning::`; comment on the server-side event/workflow binding. Delta spec scenario "Default-branch token from another workflow or event" added; REPORTE-E4/INSTRUCTIVO trust-boundary sentence updated.
