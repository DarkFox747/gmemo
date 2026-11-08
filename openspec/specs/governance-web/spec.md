# Governance Web Specification

## Purpose

A Spanish web UI for the project's tech lead to govern shared memory: review queue, review detail, quarantine, project memory and a read-only administration view (TT-08, Figures 12–16).

## Requirements

### Requirement: Shell and roles

Source: governance-web

The web SHALL show a sidebar with the brand, navigation with pending badges for the review queue and quarantine, a project selector, and the current role. In development it SHALL offer a user selector (tech lead, contributor, viewer) that sends `X-Dev-User`. Screens a role cannot use SHALL show a clear "sin permisos" state instead of errors.

#### Scenario: Viewer opens the review queue
- GIVEN the viewer user is selected
- WHEN opening "Cola de revisión"
- THEN a no-permission message is shown and no error appears in the console

### Requirement: Review queue and detail (Fig. 12–13)

Source: governance-web

The review queue SHALL show the four counters, the filters (Todas, Dudosas, Revisión obligatoria, Decisiones, Restricciones) and a table with type chip, title, reason, confidence bar, origin (branch · PR), author, date and a Revisar action. The detail SHALL show content and type fields, the judge verdict card (state, determining criterion, confidence versus threshold, justification, mandatory review) and the related unit card with the "mark as superseded" checkbox, and allow approving, rejecting with a required reason, or postponing.

#### Scenario: Reject requires a reason
- GIVEN an open review item
- WHEN the tech lead clicks reject with an empty reason
- THEN the form shows a validation message and no request is sent

#### Scenario: Concurrent change
- GIVEN the item's target changed meanwhile
- WHEN the tech lead approves
- THEN a clear conflict message is shown and the item stays in the queue

### Requirement: Quarantine (Fig. 14)

Source: governance-web

The quarantine screen SHALL list entries with reason, unit, monospace redacted excerpt, entry date and days until expiry, filterable by reason, with View and Restore actions; the restore result SHALL appear in a toast, and the footer SHALL state that restorations are recorded as labels to measure the judge's false negatives.

#### Scenario: Restore shows the outcome
- GIVEN a quarantine entry
- WHEN the tech lead restores it
- THEN a toast shows whether it was applied, queued or quarantined again

### Requirement: Project memory (Fig. 16)

Source: governance-web

The project memory screen SHALL offer Active and Pending revalidation tabs, type filter and search, version history, an add/edit form with type-specific fields that previews the judge verdict before confirming, retire with reason, confirm or retire pending memories, and bulk retire by PR.

#### Scenario: Preview then confirm
- GIVEN the tech lead fills a new gotcha
- WHEN they preview and then confirm
- THEN the verdict is shown before confirming and the new memory appears in the Active tab

### Requirement: Administration (Fig. 15)

Source: governance-web

The administration screen SHALL be read-only: project, repositories, members with role, and service credentials with status, never showing secrets.

#### Scenario: No secrets
- GIVEN a project with a service credential
- WHEN the admin screen loads
- THEN the credential shows name, role and status and no token or hash

### Requirement: Safe rendering and delivery

Source: governance-web

All server-provided text SHALL be rendered as text (never as HTML). The web SHALL be built into the server image and served at `/` by `docker compose up --build` in development, compatible with the strict same-origin CSP.

#### Scenario: Script in memory content
- GIVEN a memory whose title contains `<script>alert(1)</script>`
- WHEN it is displayed
- THEN the literal text is shown and no script runs

## History

None.

### Requirement: Judge verdict readable in Spanish

Source: demo-ux-polish

The review detail SHALL show, for the determining criterion, a Spanish explanation from `labels.ts` (one per criterion, missing label = compile error), followed by the judge's original justification labelled "Texto original del Juez", rendered as text.

#### Scenario: Contradiction explained
- GIVEN an uncertain item with criterion `contradiction`
- WHEN the tech lead opens it
- THEN a Spanish explanation of the contradiction criterion is shown and the original justification appears below it

### Requirement: Proposal vs related unit comparison

Source: demo-ux-polish

When an item has a related unit, the detail SHALL show both side by side (title and summary — the related unit DTO carries no body; the proposal body is shown in full elsewhere) with word-level differences highlighted using text nodes only, and with a screen-reader text marker for added and removed words.

#### Scenario: Changed value highlighted
- GIVEN a proposal "for 5 minutes" related to an active "for 30 minutes"
- WHEN the detail renders
- THEN "5" is marked as added on the proposal side and "30" as removed on the related side

### Requirement: Confidence relative to threshold

Source: demo-ux-polish

Confidence bars SHALL show a threshold marker and use the success color at or above the threshold and the warning color below it.

#### Scenario: Below threshold
- GIVEN confidence 0.70 and threshold 0.80
- WHEN the bar renders
- THEN it is amber and the marker sits at 80 %

### Requirement: Live refresh

Source: demo-ux-polish

The review queue, quarantine list and sidebar badges SHALL refresh every 5 seconds while the tab is visible, pause while hidden, and stop on unmount, without resetting filters or scroll.

#### Scenario: New item appears
- GIVEN the queue is open
- WHEN a promotion enqueues a new item
- THEN it appears and the badge increases within one interval, without reload

### Requirement: Review keyboard shortcuts

Source: demo-ux-polish

In the review detail, `A` SHALL arm an approval that must be confirmed by pressing `A` again or Enter within 3 seconds, and `R` SHALL focus the rejection reason (rejecting still requires the button); shortcuts are ignored while focus is in an input, textarea, select or contenteditable element, with Shift/Ctrl/Meta/Alt, during IME composition, on key repeat and while an action is in progress.

#### Scenario: Typing is safe
- GIVEN focus in the rejection reason textarea
- WHEN the user types "A"
- THEN no approval happens
