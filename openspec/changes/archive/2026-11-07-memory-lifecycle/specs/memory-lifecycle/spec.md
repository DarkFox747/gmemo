# Memory Lifecycle Specification

## Purpose

Memories expire into revalidation, the tech lead confirms or retires them, and memories from a reverted PR can be retired in bulk (HU-12, HU-11.4).

## Requirements

### Requirement: Revalidation deadline and periodic sweep (HU-12.1, HU-12.4)

Every applied memory SHALL get `revalidate_at = now() + REVALIDATION_DAYS` (default 60), except type `outcome`, which SHALL have none. A periodic job (`POST /internal/jobs/revalidation-sweep`, `pnpm job:revalidation`) SHALL move active memories whose deadline has passed to `pending_revalidation`, after which they are no longer returned by recall, get_memory or get_context.

#### Scenario: Expired memory leaves search
- GIVEN an active `gotcha` whose `revalidate_at` is in the past
- WHEN the sweep runs
- THEN it becomes `pending_revalidation`, the job reports it in its count, and recall no longer returns it

#### Scenario: Outcomes never expire
- GIVEN an active `outcome` memory
- WHEN it is applied and when the sweep runs
- THEN its `revalidate_at` is NULL and it stays active

#### Scenario: Sweep is idempotent
- GIVEN the sweep already ran
- WHEN it runs again with no new expirations
- THEN it reports 0 and changes nothing

### Requirement: Confirm (HU-12.2)

The project's tech lead SHALL confirm a `pending_revalidation` memory, returning it to `active` with a new deadline.

#### Scenario: Confirm restores the memory
- GIVEN a pending memory
- WHEN the tech lead confirms it
- THEN it is active, `revalidate_at` is now + 60 days, and recall returns it again

#### Scenario: Confirm on a non-pending memory
- GIVEN an active memory
- WHEN confirm is requested
- THEN the response is the uniform 404

### Requirement: Retire with reason (HU-12.3)

The tech lead SHALL retire an active or pending memory with a reason (3–500 chars). It becomes `deprecated`, records `retired_reason`, and gets a new revision preserving the history.

#### Scenario: Retire pending
- GIVEN a pending memory
- WHEN the tech lead retires it with reason "obsolete after migration"
- THEN it is `deprecated`, `retired_reason` is stored, a revision with op `deprecate` exists, and it is excluded from reads

### Requirement: Bulk retire by PR (HU-11.4)

The tech lead SHALL retire, in one transaction, every active or pending memory of the project whose origin PR equals a given number, with a reason. The response returns the count.

#### Scenario: Reverted PR
- GIVEN three active memories from PR 42 and one from PR 43 in project P, and one from PR 42 in project Q
- WHEN the tech lead of P retires by PR 42
- THEN the three P memories are deprecated with revisions, the response is `{retired: 3}`, and the PR 43 and project Q memories are untouched

### Requirement: Access

Only the project's `project_admin` SHALL use the lifecycle endpoints. Others receive the uniform 404.

#### Scenario: Contributor denied
- GIVEN a contributor of the project
- WHEN they call retire-by-pr
- THEN they receive 404 and nothing changes
