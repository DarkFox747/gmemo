# Direct Memory Management Specification

## Purpose

The project's tech lead creates, edits, browses and retires memory directly from the web, through the same validation pipeline, judge and apply path as agent promotions (HU-13).

## Requirements

### Requirement: Browse project memory

Source: direct-memory-management

The tech lead SHALL list project memories filtered by type, status and free text, paginated, and open one with its revision history.

#### Scenario: History kept
- GIVEN a memory amended twice
- WHEN the tech lead opens it
- THEN it shows version 3 and three revisions with op, author and date

### Requirement: Preview before confirming (HU-13.1)

Source: direct-memory-management

A preview SHALL run field validation, the pipeline and the judge on a proposed unit without persisting anything, and report pipeline findings, verdict, criterion, confidence versus threshold, justification, and any duplicated or contradicted active memory.

#### Scenario: Preview reports a duplicate
- GIVEN an active memory with the same normalized title
- WHEN the tech lead previews an add with that title
- THEN the response shows `rejected`/`duplication` with the related memory, no domain row (staging, memory, quarantine) was written, and only the read audit entry exists

### Requirement: Confirmed add and edit (HU-13.1, HU-13.2)

Source: direct-memory-management

On confirmation, the unit SHALL go through the same pipeline and apply path as promotions. The tech lead's confirmation counts as human approval, so it is applied even when the judge is uncertain or the type requires mandatory review, with provenance `web_ui`, and author and approver the tech lead. An add creates version 1; an edit with the current `expectedRevision` creates a new revision, keeps history, and regenerates search indexes and the vector. A stale `expectedRevision` MUST return 409.

#### Scenario: Add a decision directly
- GIVEN a valid decision the judge accepts with mandatory review
- WHEN the tech lead confirms it
- THEN a memory exists with provenance `web_ui`, version 1, `approved_by` = the tech lead, and it is returned by recall

#### Scenario: Concurrent edit
- GIVEN the memory moved to revision 4 after the tech lead loaded revision 3
- WHEN they confirm an edit with `expectedRevision: 3`
- THEN the response is 409 and nothing changes

### Requirement: Same security treatment (HU-13.4)

Source: direct-memory-management

A directly written unit containing a credential or embedded instructions SHALL be quarantined exactly as an agent proposal (redacted, leak flag and alert for credentials), and a judge rejection SHALL also quarantine it. The confirmation never overrides these.

#### Scenario: Credential in a direct add
- GIVEN a unit whose body contains an access key
- WHEN the tech lead confirms it
- THEN it is quarantined redacted, `leak_detected` is notified, and no memory is created

### Requirement: Only the tech lead (HU-13.5)

Source: direct-memory-management

Contributors, viewers and non-members MUST receive the uniform 404 on every direct-management endpoint, and no write occurs.

#### Scenario: Contributor denied
- GIVEN a contributor of the project
- WHEN they confirm an add
- THEN they receive 404 and no row is written

## History

None.
