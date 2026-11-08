# Delta for Promotion

## MODIFIED Requirements

### Requirement: OIDC fail-closed and default-branch enforcement

Any verification failure (wrong audience, wrong issuer, expired or not-yet-valid, bad signature, missing `repository` or `ref`) MUST result in `PERMISSION_DENIED` with no enumerable detail. For the merged event, the `/promote` handler MUST assert `repo == principal.repository` and that the token `ref` is `refs/heads/<repo.default_branch>`, its `event_name` is `push` and its `job_workflow_ref` is `<repository>/.github/workflows/promote.yml@refs/heads/<repo.default_branch>` (the trusted post-merge workflow; any other workflow file or event on the default branch, e.g. `workflow_dispatch`, `schedule` or `pull_request_target`, is denied; a missing claim is denied). The session promoted is the one of `source_branch`: either the default branch itself, or a feature branch, in which case `pr_number` MUST be present and is recorded as the origin PR (HU-04.1).
(Previously: `ref == source_branch` and `source_branch == repo.default_branch`, so feature-branch sessions could never be promoted.)

#### Scenario: Merged PR promotes its feature branch
- GIVEN an open session on `feature/x` with an accepted item and a token minted on the default branch
- WHEN `/promote` receives `{repo, source_branch:"feature/x", pr_number:7}`
- THEN the item is applied with `origin_branch = feature/x` and `origin_pr = 7`, and the session is promoted

#### Scenario: Repeated merge event is idempotent
- GIVEN the feature session was already promoted
- WHEN the same event arrives again
- THEN the response is `no_op` and nothing changes

#### Scenario: Feature source without a PR number
- GIVEN a token minted on the default branch
- WHEN `/promote` receives a feature `source_branch` without `pr_number`
- THEN `PERMISSION_DENIED` is returned

#### Scenario: Token not minted on the default branch
- GIVEN a valid token whose `ref` is a feature branch or `refs/pull/<n>/merge`
- WHEN `/promote` is called for the merged event (any `source_branch`)
- THEN `PERMISSION_DENIED` is returned

#### Scenario: Default-branch token from another workflow or event
- GIVEN a valid token with `ref = refs/heads/<default>` whose `event_name` is not `push` (e.g. `pull_request_target`, `workflow_dispatch`, `schedule`, or absent), or whose `job_workflow_ref` is not `promote.yml` on the default branch of the same repository (or is absent)
- WHEN `/promote` is called for the merged event (any `source_branch`)
- THEN `PERMISSION_DENIED` is returned and nothing is promoted

#### Scenario: Default branch unchanged
- GIVEN a token minted on the default branch
- WHEN `/promote` receives `source_branch` = default branch, with or without `pr_number`
- THEN the default-branch session is promoted as before

#### Scenario: Bad token
- GIVEN a wrong-audience, wrong-issuer, expired, badly signed or claim-less token
- WHEN posting `/promote`
- THEN `PERMISSION_DENIED` is returned

### Requirement: Composition root and workflow

`src/index.ts` MUST use the real `GithubOidcAuthenticator` when `PROMOTE_OIDC_DEV_BYPASS=false`, keeping the dev branch and its production guard, and config MUST require `GITHUB_OIDC_AUDIENCE` on the real path. `.github/workflows/promote.yml` MUST trigger on push to the default branch, request an OIDC token (`permissions: id-token: write`, configured audience) and `POST /promote` with a body matching the `.strict()` schema, with no long-lived secrets. The push job MUST look up the PR associated with the pushed commit (`GITHUB_TOKEN`, `pull-requests: read`); if exactly one merged, same-repository PR targets the default branch and its `merge_commit_sha` is the pushed commit, the body MUST carry its head branch as `source_branch` and its `pr_number`; otherwise the body MUST carry the default branch. Untrusted values (head branch name) MUST be passed through env and `jq --arg` only.
(Previously: the body always carried the default branch.)

#### Scenario: Workflow auth
- GIVEN a merged PR
- WHEN the workflow runs
- THEN it authenticates with OIDC only and promotes the PR's head branch session

#### Scenario: Direct push
- GIVEN a push to the default branch with no associated merged PR
- WHEN the workflow runs
- THEN it promotes the default-branch session

### Requirement: PR closed without merge discards staged units (HU-04.2)

(Unchanged except the scenario below.)

#### Scenario: Merged path with a feature branch
- GIVEN a merge event whose `source_branch` is not the default branch
- WHEN `/promote` is called without `event`, with a default-branch token and `pr_number`
- THEN the feature session is promoted (it is no longer denied)
(Previously: "Merged path unchanged — it is denied as before".)
