# Delta for memory-read

## MODIFIED Requirements

### Requirement: Only active memories are served (HU-08.2, HU-09)

recall (lexical and semantic), get_memory and get_context SHALL return only `active` memories; `superseded`, `deprecated` and `pending_revalidation` MUST NOT be returned, and get_memory on such a handle MUST fail with the same opaque error as an unknown handle.
(Previously: only superseded and deprecated were listed.)

#### Scenario: Each non-active status is hidden
- GIVEN one memory in each of superseded, deprecated and pending_revalidation matching a query
- WHEN recall, get_memory and get_context are called
- THEN none of them is returned
