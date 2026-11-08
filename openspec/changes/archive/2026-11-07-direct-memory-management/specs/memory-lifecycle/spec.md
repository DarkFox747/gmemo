# Delta for memory-lifecycle

## MODIFIED Requirements

### Requirement: Memory list

The project memory list SHALL default to status `active`, page size 20, newest-updated first, with an opaque `nextCursor`, and accept `type`, `status` and `q` filters.
(Previously: pending-revalidation list only, ordered by revalidate_at.)

#### Scenario: Pending tab
- GIVEN two pending memories
- WHEN listing with `status=pending_revalidation`
- THEN both are returned
