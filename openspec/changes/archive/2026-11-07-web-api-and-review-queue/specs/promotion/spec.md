# Delta for promotion

## ADDED Requirements

### Requirement: PR closed without merge discards staged units (HU-04.2)

`POST /promote` SHALL accept `event: "merged" | "closed_unmerged"` (default `merged`). For `closed_unmerged`, with the same OIDC authentication and a required `pr_number`, the open staging session of the repository and source branch SHALL be marked `abandoned` and its non-promoted items discarded, in one transaction. The `merged` path keeps its default-branch restriction unchanged.

#### Scenario: Closed PR discards
- GIVEN an open session on `feature/x` with 3 staged items
- WHEN `/promote` receives `{event:"closed_unmerged", source_branch:"feature/x", pr_number:7}`
- THEN the session is `abandoned`, its items are gone, and the response reports 3 discarded

#### Scenario: Repeated close is a no-op
- GIVEN the session was already abandoned
- WHEN the same event arrives again
- THEN the response is `no_op` and nothing changes

#### Scenario: Merged path unchanged
- GIVEN a merge event whose `source_branch` is not the default branch
- WHEN `/promote` is called without `event`
- THEN it is denied as before
