# Delta for Web API

## ADDED Requirements

### Requirement: Governance insight endpoints are admin-only, read-only and audited

`GET /api/v1/projects/:projectId/dashboard`, `GET …/activity` and `GET …/staging` SHALL be available only to the project's `project_admin`. A contributor, viewer, non-member, or a foreign, nonexistent or malformed project id MUST receive the same 404 `{error:"Not found"}` as any other project route, and no `access_log` row SHALL be written for a denied request. Every query string SHALL be validated with a strict schema: an unknown or repeated key, or an out-of-range value, MUST return 400 `{error:"Invalid request"}` without echoing input. The endpoints SHALL NOT change any data. Each successful call SHALL write one `access_log` row with action `read` and `detail.api` equal to `dashboard.read`, `activity.list` or `staging.list`, carrying only counters or the status filter (never titles, content or query text). Responses SHALL carry `Cache-Control: no-store`.

#### Scenario: Contributor gets the uniform 404
- GIVEN a contributor of project A
- WHEN they call `GET /api/v1/projects/A/dashboard`, `/activity` and `/staging`
- THEN each response is 404 with a body byte-identical to the one for a random project id
- AND no `access_log` row is written

#### Scenario: Unknown query key rejected
- GIVEN the tech lead of project A
- WHEN they call `GET /api/v1/projects/A/dashboard?days=90`
- THEN the response is 400 `{error:"Invalid request"}` and nothing is audited

#### Scenario: Successful read is audited without content
- GIVEN the tech lead of project A
- WHEN they call `GET /api/v1/projects/A/activity?limit=10`
- THEN the response is 200
- AND one `access_log` row exists with action `read`, `detail.api = "activity.list"`, `detail.resultCount` and no title, body or query text

### Requirement: Governance dashboard (Inicio)

`GET …/dashboard` SHALL return, for the project only: memory counts by status and active memories by type; review-queue counts (pending, uncertain, mandatory) computed with the same queue predicate as the review queue; active (non-restored) quarantine entries in total and by criterion; and the judge section over a 30-day window (`windowDays: 30`). The judge section SHALL contain:

- **Outcomes** of staging items from agent sessions finalized by a promotion within the window: `accepted`, `uncertain` (the judge's own doubt, including accepted-below-threshold), `rejected` (judge criteria `duplication`, `specificity`, `security_second_layer`), `pipelineBlocked` (rejected without a judge criterion) and `notEvaluated` (`stale_target`, or the judge/context unavailable).
- **Labels** recorded within the window: uncertain approved, uncertain rejected, accepted approved, accepted rejected (review decisions), and restores of judge quarantines; restores of pipeline and human-review quarantines reported separately.
- **Unlabeled coverage**: judge-accepted items applied without review, and judge rejections never restored.
- **False-positive indicator** = (uncertain approved + judge restores) / (uncertain approved + judge restores + accepted approved).
- **False-negative indicator** = accepted rejected / (accepted rejected + uncertain rejected).

Each indicator SHALL return its numerator, denominator and rate, with rate `null` when the denominator is 0. Items in server-owned `restore/` and `web/` sessions, items never evaluated by the judge (`pending`), `stale_target` items and judge-unavailable items SHALL NOT be counted as labels.

#### Scenario: Live judge indicators from stored labels
- GIVEN, in the last 30 days, 2 uncertain items approved, 2 uncertain items rejected, 5 judge-accepted mandatory items approved, 1 judge-accepted mandatory item rejected, 1 restored judge quarantine and 1 restored pipeline quarantine
- WHEN the tech lead calls `GET …/dashboard`
- THEN `falsePositive` is `{count: 3, of: 8, rate: 0.375}`
- AND `falseNegative` is `{count: 1, of: 3}` with rate 1/3
- AND `restoredOther.pipeline` is 1 and is not part of either indicator

#### Scenario: No labels yet
- GIVEN a project where no item has been reviewed or restored in the last 30 days
- WHEN the dashboard is requested
- THEN both indicators have `of: 0` and `rate: null`

#### Scenario: Non-judge items are excluded from labels
- GIVEN an approved item whose criterion is `stale_target`, an approved item whose judge reason is `judge_unavailable`, and an approved item in a `restore/` session
- WHEN the dashboard is requested
- THEN none of them is counted in `labels` or in the indicators

#### Scenario: Labels outside the window are ignored
- GIVEN an uncertain item approved 31 days ago
- WHEN the dashboard is requested
- THEN it is not counted in `labels.uncertainApproved`

#### Scenario: Queue count equals the review queue
- GIVEN 3 uncertain and 2 mandatory queued items
- WHEN the dashboard is requested
- THEN `queue` is `{pending: 5, uncertain: 3, mandatory: 2}`, equal to the review-queue counters

### Requirement: Activity timeline (Actividad)

`GET …/activity` SHALL return the project's state-changing audit events, newest first: agent remember and discard, promotion runs with their applied/queued/quarantined counters, PRs closed without merge, review approve and reject, quarantine restore, direct create, amend, confirm, retire and retire-by-PR, and platform jobs that touched the project (with this project's count only). Read events SHALL NOT be listed. Each event SHALL carry an id, timestamp, a stable action code (unknown kinds as `other`), the actor kind (`user`, `agent`, `ci`, `system`) with a display name only for users and agents (never an email, identity subject, user id, CI identity or job trigger), the target type and title when it still exists in the same project (else `null`; staging and quarantine titles PII-masked), and only allow-listed facts (branch capped at 200 characters, PR number, counters, outcome). The response MUST NOT contain the stored query hash, session ids, merge SHA, raw `detail` or any content beyond titles. Filters: optional `category` (`staging`, `promotion`, `review`, `quarantine`, `memory`, `jobs`); keyset pagination with an opaque `cursor` (`nextCursor` is `null` on the last page) and `limit` 1–100 (default 50, digits only).

#### Scenario: Reads are not part of the timeline
- GIVEN a project with a `memories.list` read, an agent `remember` and a review approval
- WHEN the tech lead lists the activity
- THEN only the remember and the approval are returned, approval first

#### Scenario: Actor rendering
- GIVEN a promotion run by CI, an agent remember on behalf of user "Ana" and a retire by the tech lead "Diego"
- WHEN the activity is listed
- THEN the actors are `{kind:"ci", name:null}`, `{kind:"agent", name:"Ana"}` and `{kind:"user", name:"Diego"}`, and no email appears in the response

#### Scenario: No hashes or raw detail leak
- GIVEN an audit row with a `query_hash` and a promotion row with a merge SHA
- WHEN the activity is listed
- THEN neither value appears anywhere in the response body

#### Scenario: Target resolved only inside the project
- GIVEN an approval row whose detail references a memory of another project
- WHEN the activity is listed
- THEN that event's `target` is `null`

#### Scenario: Jobs scoped to the project
- GIVEN a quarantine purge that deleted 2 entries of project A and 3 of project B, and a revalidation sweep that touched only project B
- WHEN project A's activity is listed with `category=jobs`
- THEN one `job.quarantine_purge` event with `facts.count = 2` is returned

#### Scenario: Stable pagination
- GIVEN 120 events
- WHEN the tech lead requests `limit=50` and follows `nextCursor` twice
- THEN the three pages contain 50, 50 and 20 distinct events in descending order and the last `nextCursor` is `null`

#### Scenario: Malformed cursor
- GIVEN the tech lead of the project
- WHEN they request `cursor=-1`, `cursor=abc` or a cursor above the 64-bit range
- THEN the response is 400 `{error:"Invalid request"}`

### Requirement: Staging overview (Área de preparación)

`GET …/staging` SHALL return the project's agent staging sessions: `status=open` (default) lists open sessions by latest activity; `status=closed` lists sessions promoted, partially promoted, rejected or abandoned within the last 7 days by closing time. Sessions on the server-owned `restore/` and `web/` branches SHALL be excluded. Each session SHALL carry repo label (the repository slug, else its remote URL without credentials), branch, status, PR number, opener display name, creation, last activity, expiry, closing time, total item count and at most 100 newest items with `itemsTruncated`. Each item SHALL carry op, type, title (PII-masked), judge state and criterion, mandatory-review flag, creation time and a state (`staged`, `queued`, `applied`, `quarantined`, `review_rejected`); summaries, bodies, fields and authors SHALL NOT be returned. `limit` (1–50, default 20) caps sessions and sets `truncated`.

#### Scenario: Open session with mixed items
- GIVEN an open session on `feature/login` with a pending item and a capture-time `stale_target` item
- WHEN the tech lead requests `GET …/staging`
- THEN the session is listed with the items in states `staged` and `queued`

#### Scenario: Recently closed sessions
- GIVEN a session promoted 6 days ago and one abandoned 8 days ago
- WHEN the tech lead requests `status=closed`
- THEN only the session promoted 6 days ago is returned, with its items' final states

#### Scenario: Reserved sessions excluded
- GIVEN an open `restore/<id>` session and an open `web/<user>/<id>` session
- WHEN the staging overview is requested
- THEN neither session appears

#### Scenario: Unmasked PII is not exposed
- GIVEN an open-session item titled "Ask ana@example.com about retries"
- WHEN the staging overview is requested
- THEN the item title is returned with the email replaced by `[EMAIL]`
