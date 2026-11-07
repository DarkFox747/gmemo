# Delta for promotion

## ADDED Requirements

### Requirement: Structured judge verdict

Every judge evaluation SHALL produce and persist a verdict (`accepted` | `uncertain` | `rejected`), a determining criterion (`specificity`, `duplication`, `contradiction`, `grounding`, `confidence`, `security_second_layer`), a confidence in [0, 1] and a justification. The judge MUST receive as context up to 3 similar active memories of the same project, delimited as untrusted data. A related memory reference MUST only be stored if it belongs to that context.

#### Scenario: Accepted with confidence at or above threshold is applied (HU-06.1)
- GIVEN a staged `gotcha` whose judge result is `accepted` with confidence ≥ `JUDGE_CONFIDENCE_THRESHOLD`
- WHEN the branch is promoted
- THEN a memory is created with version 1, the author's identity and origin branch/PR
- AND the staging item stores verdict, criterion, confidence and reason

#### Scenario: Duplicate of an active memory is rejected with reference (HU-06.2)
- GIVEN an active memory and a staged item the judge marks `rejected`/`duplication` with that memory as related
- WHEN promoted
- THEN the item is quarantined with reason `duplicate_content` and `related_memory_id` set to the active memory
- AND no memory is created

#### Scenario: Contradiction or low confidence is queued (HU-06.3)
- GIVEN a judge result `uncertain`/`contradiction`, or `accepted` with confidence below the threshold
- WHEN promoted
- THEN the item is not applied, stays in the review queue, and the low-confidence case is stored as `uncertain`/`confidence`
- AND the project's tech lead is notified (`review_enqueued`)

#### Scenario: Mandatory review even when accepted (HU-06.4)
- GIVEN an item of a type listed in `MANDATORY_REVIEW_TYPES`, or any `supersede`/`deprecate` operation, that the judge accepts above threshold
- WHEN promoted
- THEN it is not applied, `mandatory_review` is true and it is in the review queue
- AND `review_enqueued` is notified

#### Scenario: Second-layer security rejection blocks (HU-06.5)
- GIVEN the judge returns `rejected`/`security_second_layer`
- WHEN promoted
- THEN the item is quarantined with its content redacted, `sanitize_flags.leak` is true and `leak_detected` is notified

#### Scenario: Model unavailable never auto-accepts (HU-06.6)
- GIVEN the model times out, errors, or returns output that is not valid JSON per the schema
- WHEN the item is evaluated
- THEN the result is `uncertain`/`confidence` and the item is queued, never applied

### Requirement: Validation pipeline before the judge

Before the judge, promotion SHALL run on every non-terminal item, in order: credential detection, embedded-instruction detection, and personal-data masking. Format, required fields and size limits stay enforced as today.

#### Scenario: Credential → quarantine, leak flag and alert (HU-05)
- GIVEN a staged item containing a credential pattern
- WHEN promoted
- THEN it is quarantined with reason `secret_detected` and redacted content, `sanitize_flags.leak` is true and `leak_detected` is notified
- AND the secret value is never logged

#### Scenario: Embedded instructions → quarantine (HU-05)
- GIVEN a staged item whose text contains instructions aimed at agents (e.g. "ignore previous instructions", "ignorá las reglas", "you are now")
- WHEN promoted
- THEN it is quarantined with reason `embedded_instructions` and the judge is not called

#### Scenario: Personal data is masked, not blocked (HU-05)
- GIVEN a staged item containing an email, a phone number or a DNI/CUIT
- WHEN promoted
- THEN those spans are replaced by `[EMAIL]`, `[PHONE]` or `[ID]` before the judge and in the stored memory
- AND `sanitize_flags.pii` lists the categories and the item continues through the pipeline

#### Scenario: Previously uncertain items are sanitized too
- GIVEN an item persisted as `uncertain` at capture
- WHEN promoted
- THEN the pipeline runs on it before it is queued

### Requirement: Notifier

The system SHALL notify the project's tech lead through a `Notifier` seam whenever an item enters the review queue (`review_enqueued`) or a leak is detected (`leak_detected`). The demo implementation MUST write a structured log carrying project id, event and category names only, never content.

#### Scenario: Notification payload has no content
- GIVEN a leak is detected
- WHEN the notifier is called
- THEN the log entry contains the event, project id and categories, and no title, body or matched text

## MODIFIED Requirements

### Requirement: Stale target revision goes to human review (HU-11.3)

An `amend`, `supersede` or `deprecate` whose `target_revision` is no longer current SHALL be stored as `uncertain` with criterion `stale_target` and `mandatory_review = true`, both at capture and at promotion, and SHALL NOT be quarantined.
(Previously: a stale target found at promotion was quarantined with reason `stale_target`.)

#### Scenario: Stale target at promotion
- GIVEN an `amend` captured against revision N, and the memory has since moved to N+1
- WHEN promoted
- THEN no quarantine row is created, the item is `uncertain`/`stale_target` with `mandatory_review` true, and `review_enqueued` is notified

### Requirement: Judge configuration

`JUDGE_CONFIDENCE_THRESHOLD` (0..1, default 0.80), `MANDATORY_REVIEW_TYPES` (CSV of memory types, default `decision,constraint,domain_rule`) and `JUDGE_STUB_CONFIDENCE` (0..1, default 0.9) SHALL be validated at startup. `JUDGE_STUB_VERDICT` is removed. The deterministic judge MUST remain impossible under `NODE_ENV=production`.
(Previously: the deterministic judge returned the constant `JUDGE_STUB_VERDICT`.)

#### Scenario: Invalid threshold fails fast
- GIVEN `JUDGE_CONFIDENCE_THRESHOLD=1.5`
- WHEN configuration loads
- THEN startup fails with an explicit error

#### Scenario: Unknown type in mandatory list fails fast
- GIVEN `MANDATORY_REVIEW_TYPES=decision,foo`
- WHEN configuration loads
- THEN startup fails with an explicit error

### Requirement: Idempotent promotion (regression)

Repeated promotion notifications for the same session MUST NOT apply, quarantine, queue or notify an item twice.

#### Scenario: Second promotion is a no-op
- GIVEN a session already promoted
- WHEN the same promotion is received again
- THEN nothing is applied, quarantined or notified again
