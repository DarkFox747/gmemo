# Delta for promotion

## ADDED Requirements

### Requirement: Revalidation deadline on apply

Every apply path (promotion, review approval, quarantine restore) SHALL set `revalidate_at = now() + REVALIDATION_DAYS` for non-`outcome` memories and NULL for `outcome`, including amends.

#### Scenario: Amend resets the deadline
- GIVEN an active memory with a deadline 10 days away
- WHEN an amend is applied
- THEN its deadline becomes now + 60 days
