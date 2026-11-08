# Web API Specification

## Purpose

Authenticated REST API (`/api/v1`) for the governance web. It shares the MCP facade's authentication (Gate 1), authorization (Gate 2), auditing and opacity guarantees.

## Requirements

### Requirement: Same gates as MCP, opaque errors

Every `/api/v1` route SHALL authenticate with the same Gate 1 as `/mcp` and authorize with Gate 2 against the RDS membership. Authentication failures MUST return 401 `{error:"Unauthorized"}`. On project routes, an authorization failure and a nonexistent resource MUST return the identical 404 `{error:"Not found"}`. Invalid input MUST return 400 `{error:"Invalid request"}` without echoing input. Successful reads and writes SHALL be audited; denied requests SHALL NOT be.

Source: web-api-and-review-queue

#### Scenario: Foreign project indistinguishable from missing
- GIVEN a tech lead of project A
- WHEN they request the review queue of project B (exists) and of a random project id
- THEN both responses are 404 with byte-identical bodies and no access_log row is written

#### Scenario: Missing credentials
- GIVEN no Authorization header and dev bypass disabled
- WHEN calling `GET /api/v1/me`
- THEN the response is 401 `{error:"Unauthorized"}`

#### Scenario: Rate limited
- GIVEN more requests than `RATE_LIMIT_API_MAX` within the window
- WHEN another request arrives
- THEN it receives 429

### Requirement: Development login

When `AUTH_DEV_BYPASS` is enabled (development only), the API SHALL accept `X-Dev-User: <email>` and act as that existing, enabled user. If the header is absent, it acts as the default development user. An unknown email MUST return 401. Under `NODE_ENV=production` the header MUST have no effect.

Source: web-api-and-review-queue

#### Scenario: Switch role in development
- GIVEN the seeded users `tl@demo.local` (project_admin) and `viewer@demo.local` (viewer)
- WHEN `GET /api/v1/me` is called with each `X-Dev-User`
- THEN each response shows that user's projects and role

#### Scenario: Header ignored in production
- GIVEN `NODE_ENV=production`
- WHEN a request carries `X-Dev-User`
- THEN authentication uses only the Authorization token (a missing token gives 401)

### Requirement: Identity endpoint

`GET /api/v1/me` SHALL return the authenticated user (id, email, display name) and the non-archived projects they belong to, with their role. It SHALL NOT expose project content.

Source: web-api-and-review-queue

#### Scenario: Platform admin without membership
- GIVEN a platform_admin with no project memberships
- WHEN calling `/api/v1/me`
- THEN the project list is empty

### Requirement: Review queue (HU-07)

Only the project's `project_admin` SHALL list, open, approve or reject review-queue items. The queue is every staging item of the project not yet promoted, not rejected, not reviewed, and either `uncertain` or `mandatory_review`.

Source: web-api-and-review-queue

#### Scenario: Open an item shows the full context (HU-07.1)
- GIVEN a queued item with a related active memory
- WHEN the tech lead opens it
- THEN the response contains content and type fields, origin branch and PR, author, verdict, criterion, confidence and the configured threshold, justification, `mandatory_review`, and the related units with status, version and origin

#### Scenario: Approve integrates and records the approver (HU-07.2)
- GIVEN a queued `add` item
- WHEN the tech lead approves it
- THEN a memory is created through the same apply path as promotion, with `approved_by` set to the tech lead
- AND the item records `review_decision=approved`, `reviewed_by` and `reviewed_at`, and leaves the queue

#### Scenario: Approve and supersede the related unit
- GIVEN a queued decision with a related active decision
- WHEN the tech lead approves with `markRelatedSuperseded=true`
- THEN the new memory is active, the related one is `superseded`, and a `memory_relation` links them

#### Scenario: Reject requires a reason and quarantines (HU-07.3)
- GIVEN a queued item
- WHEN the tech lead rejects it with reason "too vague" (3–500 chars)
- THEN a quarantine row is created whose reason is prefixed `human_review:` followed by that reason (the criterion column arrives in C3), and the item records `review_decision=rejected`
- AND a reject without a reason, or with fewer than 3 characters, returns 400

#### Scenario: Non-admins cannot access the queue (HU-07.5)
- GIVEN a contributor, a viewer, or a user of another project
- WHEN they call any review-queue endpoint
- THEN they receive the same 404 as for a nonexistent project

#### Scenario: Concurrent resolution
- GIVEN an item already approved or rejected
- WHEN another approve or reject arrives
- THEN it returns 404 and nothing changes

#### Scenario: Counters
- GIVEN 3 uncertain and 2 mandatory queued items and 4 items reviewed in the last 7 days
- WHEN listing the queue with `filter=all`
- THEN the counters are pending 5, uncertain 3, mandatory 2, resolved last 7 days 4, and `filter=uncertain` returns only the 3 uncertain items

### Requirement: Static web in development

When `WEB_STATIC_DIR` is set (forbidden under production), the app SHALL serve the web build at `/` with an SPA fallback. The fallback MUST NOT intercept `/api`, `/mcp`, `/promote` or `/health`. HTML responses SHALL carry a restrictive same-origin Content-Security-Policy.

Source: web-api-and-review-queue

#### Scenario: Unknown API path is not the SPA
- GIVEN `WEB_STATIC_DIR` is set
- WHEN requesting `GET /api/v1/unknown`
- THEN the response is a JSON 404, not `index.html`

## History

None.
