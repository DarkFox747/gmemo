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

Source: governance-insights

The quarantine screen SHALL list entries with reason, unit, monospace redacted excerpt, entry date and days until expiry, filterable by reason, with View and Restore actions; the restore result SHALL appear in a toast, and the footer SHALL state that restorations are recorded as labels to measure the judge's false positives (good units the Juez held back), consistent with the Inicio indicators and the quarantine specification.

#### Scenario: Restore shows the outcome
- GIVEN a quarantine entry
- WHEN the tech lead restores it
- THEN a toast shows whether it was applied, queued or quarantined again

#### Scenario: Footer wording matches the metric definition
- GIVEN the quarantine screen
- WHEN it renders
- THEN the footer mentions "falsos positivos del Juez" and not "falsos negativos"

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

### Requirement: Insight views in the navigation

Source: governance-insights


The sidebar SHALL offer "Inicio", "Área de preparación" and "Actividad" in addition to the existing entries, in the order Inicio, Cola de revisión, Área de preparación, Memoria del proyecto, Cuarentena, Actividad, Administración, reachable at `#/home`, `#/staging` and `#/activity`, with `aria-current="page"` on the current entry. A route with extra or invalid segments SHALL fall back to its list route, and an empty or unknown hash SHALL open Inicio (`#/home`), the default landing screen. For a role other than `project_admin` the three screens SHALL show the "sin permisos" state without calling the API.

#### Scenario: Viewer opens Actividad
- GIVEN the viewer user is selected
- WHEN opening "Actividad"
- THEN a no-permission message is shown, no request is sent to `/activity` and no error appears in the console

### Requirement: Inicio dashboard

Source: governance-insights


The Inicio screen SHALL show memory counts by status and active memories by type, review-queue and quarantine counts with links to those screens, the judge outcomes of the last 30 days, the human corrections (uncertain approved, uncertain rejected, judge-accepted approved, judge-accepted rejected, judge quarantines restored, other restorations), and the live false-positive and false-negative indicators as a percentage with "n de m". Each indicator SHALL show, as visible text next to it, its definition: false positives are good units the Juez held back over good labelled units (good = approved in review or restored from a judge quarantine); false negatives are bad units the Juez let pass over bad labelled units (bad = rejected in review; observable only for types with mandatory review). It SHALL state the unlabelled coverage (units applied without review and judge rejections not restored) and that `docs/demo/metricas.md` holds the synthetic counterpart. An indicator without labels SHALL read "sin datos". Proportions SHALL be drawn as plain CSS bars that are decorative, with the number always present as text; no chart library is used.

#### Scenario: Indicators without labels
- GIVEN a project with no reviews or restorations in the last 30 days
- WHEN the tech lead opens Inicio
- THEN both indicators read "sin datos" and their definitions are still shown

#### Scenario: Numbers match the API
- GIVEN the dashboard API returns `falsePositive {count: 3, of: 8, rate: 0.375}`
- WHEN Inicio renders
- THEN the false-positive indicator shows "37,5 %" and "3 de 8"

### Requirement: Actividad timeline

Source: governance-insights


The Actividad screen SHALL list events in a table with date and time, actor ("Agente" or "Agente · {nombre}" for agents, "CI", "Sistema", or the user's display name), the Spanish label of the action from `labels.ts` (one per action code, a missing label is a compile error), the target as type chip and title (or "—"), and a short detail built from the event facts (branch, PR, counters, outcome). It SHALL offer category filters (Todas, Propuestas, Promociones, Revisión, Cuarentena, Memoria, Tareas), a "Cargar más" action while more pages exist, and an "Actualizar" action; it SHALL NOT poll automatically. All values SHALL be rendered as text.

#### Scenario: Filter and load more
- GIVEN more than 50 review events
- WHEN the tech lead selects "Revisión" and then "Cargar más"
- THEN only review events are shown and the second page is appended without duplicates

#### Scenario: Promotion summary
- GIVEN a promotion event with 3 applied, 1 queued and 1 quarantined on PR 12
- WHEN the timeline renders
- THEN the row reads "Promoción tras el merge" with a detail naming PR 12 and the three counters

### Requirement: Área de preparación

Source: governance-insights


The Área de preparación screen SHALL show "Abiertas" and "Cerradas (7 días)" tabs and one card per session with repository, branch, PR, status, opener, last activity, expiry or closing date and item count, each with a read-only table of items (type chip, title, operation, Juez state and criterion, item state). It SHALL indicate when the session list or a session's items were truncated. It SHALL offer no action that changes staging.

#### Scenario: Agent proposals before merge
- GIVEN an agent staged two units on `feature/login`
- WHEN the tech lead opens Área de preparación
- THEN a card for `feature/login` lists both units with state "En preparación" and Juez state "Sin evaluar"

### Requirement: "Buscar como agente" screen

Source: search-explorer-and-history


The web SHALL offer a "Buscar como agente" screen (hash route `#/search`, sidebar entry after "Memoria del proyecto") for the project's tech lead. It SHALL have:
- a labelled query input (maximum 200 characters)
- type pills (`aria-pressed`)
- a result-count select from 1 to 8 (default 5)
- a "Repositorio del agente" select whose default is "Ninguno" and whose options come from the administration summary

The search SHALL run only on submit. Results SHALL be shown in a table with position, title (linking to the memory detail), type, repository, fused score (4 decimals), lexical rank and semantic rank ("—" when absent). The screen SHALL state that only active memories are searched: superseded, retired and pending-revalidation memories and agents' staged drafts are excluded. It SHALL also state that the score is Σ 1/(60 + rango). All text SHALL be Spanish from `labels.ts` and rendered as text nodes. If the repository list cannot be loaded, the select SHALL be disabled with a visible note, and search SHALL remain usable without a boost.

Source: search-explorer-and-history

#### Scenario: Ranks shown per result
- GIVEN a result that appears lexically 2nd and is absent from the semantic list
- WHEN the tech lead searches
- THEN its row shows lexical rank 2 and semantic rank "—"

#### Scenario: Lexical-only fallback announced
- GIVEN the search response has `semantic: "unavailable"`
- WHEN results render
- THEN a notice says the embedder did not respond and the results are lexical only

#### Scenario: Errors are not echoed
- GIVEN the endpoint answers 400 or 404
- WHEN the screen shows the failure
- THEN a Spanish message from the client's error mapping is shown with `role="alert"` and no server text

### Requirement: Revision history diff

Source: search-explorer-and-history


When a memory has two or more revisions, the memory detail SHALL show a diff between two revisions chosen in two labelled selects. The default is the previous revision vs the current one. Title, summary and body SHALL be compared word by word with the shared word-diff helper, side by side, with removed words marked on the older side and added words on the newer side. A type change SHALL be shown. Fields SHALL be compared key by key, listing only added, removed or changed keys (non-string values shown as JSON text), or "Sin cambios en campos" when there are none. Choosing the same revision twice SHALL show a hint instead of a diff. All content SHALL be rendered as text nodes. With a single revision the diff SHALL NOT be shown.

Source: search-explorer-and-history

#### Scenario: Default comparison
- GIVEN a memory at version 3 whose version 2 said "retry 3 times" and version 3 says "retry 5 times"
- WHEN the tech lead opens the detail
- THEN versions 2 and 3 are preselected, "3" is marked removed and "5" is marked added

#### Scenario: Fields diff by key
- GIVEN version 1 fields `{ "rationale": "a" }` and version 2 fields `{ "rationale": "b", "scope": "api" }`
- WHEN comparing 1 and 2
- THEN `rationale` is listed as changed, `scope` as added, and unchanged keys are not listed

#### Scenario: Single revision
- GIVEN a memory with only version 1
- WHEN the detail renders
- THEN no revision diff is shown
