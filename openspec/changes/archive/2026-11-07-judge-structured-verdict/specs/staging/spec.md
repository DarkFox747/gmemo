# Delta for staging

## MODIFIED Requirements

### Requirement: Stale target at capture

When `remember` receives an `amend`, `supersede` or `deprecate` whose target revision is no longer current, it SHALL store the item as `uncertain` with criterion `stale_target`, `mandatory_review = true` and an explanatory reason, and SHALL notify `review_enqueued` once (not on a deduplicated re-submission).
(Previously: the item was stored as `uncertain` with no criterion and no notification.)

#### Scenario: Stale amend captured
- GIVEN an active memory at revision N+1 and an agent that read revision N
- WHEN the agent calls `remember` with `op: amend` targeting revision N
- THEN the staging item is `uncertain`/`stale_target` with `mandatory_review` true and `review_enqueued` is notified once

#### Scenario: Dedup does not re-notify
- GIVEN the same stale amend submitted twice with identical content
- WHEN the second call is deduplicated
- THEN no second notification is emitted
