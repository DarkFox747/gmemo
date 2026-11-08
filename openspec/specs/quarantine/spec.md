# Quarantine Specification

## Purpose

Govern rejected or unsafe knowledge units: keep a span-redacted copy with the reason, let the tech lead restore it through the full pipeline (a label to measure the judge), and purge it after a retention period (HU-10).

## Requirements

### Requirement: Classified, span-redacted quarantine entries

Source: quarantine-management

Every quarantine entry SHALL record a criterion (`pipeline`, `judge`, `human_review`), a reason code (`secret_detected`, `embedded_instructions`, `duplicate_content`, `judge_rejected`, `human_rejected`, `sanitize_failed`), the related memory when known, the original target for non-add operations, and `expires_at = quarantined_at + QUARANTINE_RETENTION_DAYS` (default 60). When a credential is detected, only the secret spans SHALL be replaced by `[REDACTADO]`; the rest of the text is kept. A secret MUST never be persisted in clear in any table. Existing entries are backfilled.

#### Scenario: Span redaction keeps context
- GIVEN a staged gotcha whose body explains a deploy issue and includes an access key
- WHEN it is quarantined for `secret_detected`
- THEN the stored body keeps the explanation with the key replaced by `[REDACTADO]`

#### Scenario: Secret never persisted
- GIVEN items containing secrets are promoted and later restored
- WHEN every text/json column of every table is scanned
- THEN no secret fragment is found

### Requirement: View quarantine (HU-10.1, HU-10.4)

Source: quarantine-management

The project's tech lead SHALL list and open quarantine entries with redacted content and reason; the author of an entry (a current project member) SHALL see their own entries; anyone else MUST receive the uniform 404. The list SHALL show reason, unit type and title, a redacted excerpt, entry date and days until expiry, filterable by reason.

#### Scenario: Author sees own only
- GIVEN a contributor authored entry E1 and another member authored E2
- WHEN the contributor lists the quarantine
- THEN only E1 is returned, and opening E2 returns 404

#### Scenario: Foreign user denied
- GIVEN a user with no membership in the project
- WHEN they list or open its quarantine
- THEN they receive the uniform 404

### Requirement: Restore (HU-10.2)

Source: quarantine-management

The tech lead SHALL restore an entry: a new staging item is created in a restoration session and immediately goes through the same pipeline and judge as a promotion, ending applied, queued for review, or quarantined again. The restoration SHALL be recorded (`restored_by`, `restored_at`, `restored_item_id`) as a label to measure judge false positives. Restoring an already-restored entry returns 404.

#### Scenario: Restore applies
- GIVEN a `specificity` entry whose content now passes
- WHEN the tech lead restores it
- THEN the response is `applied` with the memory id, and the entry records the restorer and time

#### Scenario: Restore re-quarantines
- GIVEN an entry that still contains embedded instructions
- WHEN restored
- THEN the response is `quarantined` with a new entry id and the original stays recorded as restored

### Requirement: Retention purge (HU-10.3)

Source: quarantine-management

A periodic job (`POST /internal/jobs/quarantine-purge`, `pnpm job:quarantine-purge`) SHALL delete entries past `expires_at` and report the count. Job endpoints SHALL be disabled unless in development or a `JOBS_TOKEN` (≥32 chars) is configured, compared in constant time; every refusal is an identical 404, and unauthenticated mode is impossible in production.

#### Scenario: Purge expired
- GIVEN two expired entries and one not expired
- WHEN the purge runs
- THEN two are deleted, one remains, and the job reports 2

#### Scenario: Job without token in production
- GIVEN `NODE_ENV=production` and no `JOBS_TOKEN`
- WHEN calling the job endpoint
- THEN it returns 404

## History

None.
