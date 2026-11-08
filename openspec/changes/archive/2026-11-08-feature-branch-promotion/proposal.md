# Proposal: Feature-branch promotion bound to the merged PR

## Intent

HU-04.1 says: when the PR is merged into the promotion branch, each staged unit of that PR's branch is promoted, recording origin branch and PR. The pilot only promotes the **default branch's** session (`POST /promote` requires `source_branch == default_branch`), so the units an agent stages on `feature/x` never reach project memory through the merge; the demo script works around it by re-proposing them on `main`. This is the last open functional deviation from the TFG document (REPORTE-E4 §3, backlog follow-up 6).

## Scope

### In Scope
- `POST /promote` (merged event) promotes the staging session of `source_branch` when it is a feature branch, provided the OIDC token was minted on the **default branch** (trusted post-merge workflow) and the body carries the `pr_number` of the merged PR. `origin_branch` = feature branch, `origin_pr` = PR number.
- The default-branch case keeps working unchanged (`source_branch == default_branch`, `pr_number` optional).
- `promote.yml` push job resolves the PR associated with the pushed commit (GitHub API, `GITHUB_TOKEN`, `pull-requests: read`) and, if it is a merged same-repo PR into the default branch, sends `source_branch = head.ref` and `pr_number`; otherwise falls back to the current default-branch body.
- Dev OIDC stub: merged event uses the default ref (`refs/heads/main`); `devRef = refs/heads/<source_branch>` only for `closed_unmerged`.
- `pnpm demo` promotes `feature/notif-async` directly with its PR number (no re-propose workaround); INSTRUCTIVO §6.2, REPORTE-E4, specs and backlog updated.

### Out of Scope
- Server-side verification of the PR against the GitHub API (needs a GitHub App/token on the server). The trust boundary stays the default-branch workflow, which only runs reviewed code.
- Promoting both the feature session and the default-branch session in one call.
- Fork PRs (their agents resolve to the fork's remote, not this repo's sessions).

## Approach

Change the merged-path guard in `src/http/promote.ts` from "token ref == source_branch AND source_branch == default" to "token ref == default branch AND (source_branch == default OR pr_number present)". Everything downstream (tenant, `authorizePromote`, `findOpenSessionId`, `PromoteService`, idempotency via session status, audit) is reused unchanged.

## Constraints

- Opaque `PERMISSION_DENIED` for every denial (no oracle on branch/session existence).
- Dev bypass stays impossible under `NODE_ENV=production` (existing guard).
- No new dependencies; workflow keeps actions pinned by SHA and untrusted values passed via env + `jq --arg`.
- `closed_unmerged` behaviour (C1–C7) unchanged.

## Affected Areas

| Area / Module | Impact | Description |
|---------------|--------|-------------|
| `src/http` (promote handler) | Modified | New merged-path branch guard |
| `src/auth` (dev OIDC stub usage) | Modified | devRef only for closed_unmerged |
| `.github/workflows` | Modified | PR lookup on push to main |
| `scripts` + `docs/demo` | Modified | Demo promotes the feature branch; docs |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A token from a PR workflow (attacker-controlled code) promotes unmerged work | Low | Merged path requires token ref == `refs/heads/<default>`; PR-ref tokens are denied (test) |
| Workflow sends a wrong branch | Low | Same-repo + merged + base==default filter; fallback to default body |

## Rollback Plan

Revert the change commit: the handler returns to default-branch-only promotion and the demo script to the re-propose workaround. No migration involved.

## Dependencies

- None.

## Success Criteria

- [ ] `/promote` with a default-branch token, `source_branch=feature/x`, `pr_number=N` promotes the feature session and records origin branch/PR.
- [ ] Feature source without `pr_number`, or a token whose ref is not the default branch, is denied opaquely.
- [ ] `pnpm demo` promotes `feature/notif-async` directly and stays green; full suite, lint, build green.
