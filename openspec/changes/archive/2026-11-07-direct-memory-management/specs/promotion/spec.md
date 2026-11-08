# Delta for promotion

## ADDED Requirements

### Requirement: Human-approved single-item mode

The single-item pipeline SHALL support a human-approved mode, reachable only from the project_admin direct-management API, in which review-queue routing is replaced by apply (with `approved_by` = the approver and provenance `web_ui`), while pipeline quarantine, judge rejections and apply-time duplicate quarantine still apply, and a stale target returns a conflict instead of being queued. Automatic applies set `approved_by` to NULL (approver of the current revision).

#### Scenario: Agents cannot use human approval
- GIVEN the MCP tools and the `/promote` endpoint
- WHEN they process items
- THEN the human-approved mode is never enabled
