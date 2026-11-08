# Delta for Governance Web

## ADDED Requirements

### Requirement: Judge verdict readable in Spanish
The review detail SHALL show, for the determining criterion, a Spanish explanation from `labels.ts` (one per criterion, missing label = compile error), followed by the judge's original justification labelled "Texto original del Juez", rendered as text.

#### Scenario: Contradiction explained
- GIVEN an uncertain item with criterion `contradiction`
- WHEN the tech lead opens it
- THEN a Spanish explanation of the contradiction criterion is shown and the original justification appears below it

### Requirement: Proposal vs related unit comparison
When an item has a related unit, the detail SHALL show both side by side (title and summary — the related unit DTO carries no body; the proposal body is shown in full elsewhere) with word-level differences highlighted using text nodes only, and with a screen-reader text marker for added and removed words.

#### Scenario: Changed value highlighted
- GIVEN a proposal "for 5 minutes" related to an active "for 30 minutes"
- WHEN the detail renders
- THEN "5" is marked as added on the proposal side and "30" as removed on the related side

### Requirement: Confidence relative to threshold
Confidence bars SHALL show a threshold marker and use the success color at or above the threshold and the warning color below it.

#### Scenario: Below threshold
- GIVEN confidence 0.70 and threshold 0.80
- WHEN the bar renders
- THEN it is amber and the marker sits at 80 %

### Requirement: Live refresh
The review queue, quarantine list and sidebar badges SHALL refresh every 5 seconds while the tab is visible, pause while hidden, and stop on unmount, without resetting filters or scroll.

#### Scenario: New item appears
- GIVEN the queue is open
- WHEN a promotion enqueues a new item
- THEN it appears and the badge increases within one interval, without reload

### Requirement: Review keyboard shortcuts
In the review detail, `A` SHALL arm an approval that must be confirmed by pressing `A` again or Enter within 3 seconds, and `R` SHALL focus the rejection reason (rejecting still requires the button); shortcuts are ignored while focus is in an input, textarea, select or contenteditable element, with Shift/Ctrl/Meta/Alt, during IME composition, on key repeat and while an action is in progress.

#### Scenario: Typing is safe
- GIVEN focus in the rejection reason textarea
- WHEN the user types "A"
- THEN no approval happens

