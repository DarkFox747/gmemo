# Delta for HTTP Security / Validation

## ADDED Requirements

### Requirement: Additional credential detectors
The secret scanner SHALL detect, at capture and in the promotion pipeline, kind-prefixed `sk-` keys (`sk-<2–10 letters>-<20+ token chars>`: OpenAI `sk-proj-`/`sk-svcacct-`/`sk-admin-`/`sk-None-`, Anthropic-style `sk-ant-`, `sk-or-`), GitHub fine-grained PATs (`github_pat_…`) and AWS secret access keys (a 40-character base64 value after an AWS secret key name — `aws_secret`, `aws_secret_key`, `aws_secret_access_key` with `_`, `-` or space separators, `secretAccessKey` — followed by `=`, `:` or whitespace, optionally quoted), and SHALL redact only the matched span with `[REDACTADO]`. An AWS access key id together with a bare 40-character base64 token in the same scanned text SHALL count as an AWS secret access key; in the promotion pipeline such a pair SHALL redact the whole item.

#### Scenario: Fine-grained PAT rejected at capture
- GIVEN a `remember` body containing a `github_pat_` token
- WHEN the agent stages it
- THEN the capture is rejected and nothing is stored

#### Scenario: AWS secret in promotion
- GIVEN a staged item whose fields contain `aws_secret_access_key = <40-char value>`
- WHEN it is promoted
- THEN it goes to quarantine with `leak = true` and only the value span is redacted

#### Scenario: AWS secret written with spaces
- GIVEN text `AWS secret access key <40-char value>`
- WHEN scanned
- THEN an AWS secret access key is reported and only the value span is located

#### Scenario: AWS access key id and bare secret together
- GIVEN a staged item with an AWS access key id in its title and a bare 40-character base64 token in its body
- WHEN it is promoted
- THEN it goes to quarantine with `leak = true` and the whole item is redacted

#### Scenario: Anthropic-style key
- GIVEN text containing an `sk-ant-…` key
- WHEN scanned
- THEN a credential is reported and the whole token is the redaction span

#### Scenario: No false positive
- GIVEN benign text with 40-character hashes not assigned to an AWS secret key and with no AWS access key id
- WHEN scanned
- THEN no credential is reported

### Requirement: Atomic audit for REST writes
Every REST write (review approve/reject, quarantine restore, memory create/amend/confirm/retire/retire-by-pr) SHALL write its `access_log` row in the same transaction as the data change; if the audit insert fails, the data change SHALL be rolled back and the request fails opaquely.

#### Scenario: Audit failure rolls back
- GIVEN the audit insert fails during a retire
- WHEN the tech lead retires a memory
- THEN the memory stays active and the response is the generic error

### Requirement: Restore un-claim after a failure
When a quarantine restore fails after its claim (pipeline error, audit failure, or an outcome restore cannot produce), the service SHALL abandon the `restore/<id>` session and clear the row's `restored_*` label in one statement, only while the claimed item has not been written, so the row is listed again and a retry can claim it. No audit row is written.

#### Scenario: Audit failure during restore
- GIVEN the audit insert fails during a restore
- WHEN the tech lead restores a quarantined item
- THEN nothing is applied, the restore session is abandoned, the row is active again, and a retry restores it

### Requirement: CI test gate
A GitHub Actions workflow SHALL run lint, build, web typecheck/build and the full test suite with a pgvector Postgres service on pull requests and pushes to the default branch, with pinned actions and read-only permissions.

#### Scenario: Pull request checked
- GIVEN a pull request
- WHEN CI runs
- THEN all checks run against a fresh database and the job fails on any failure
