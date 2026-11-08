# Delta for Governance Web

## ADDED Requirements

### Requirement: Insight views in the navigation

The sidebar SHALL offer "Inicio", "Área de preparación" and "Actividad" in addition to the existing entries, in the order Inicio, Cola de revisión, Área de preparación, Memoria del proyecto, Cuarentena, Actividad, Administración, reachable at `#/home`, `#/staging` and `#/activity`, with `aria-current="page"` on the current entry. A route with extra or invalid segments SHALL fall back to its list route, and an empty or unknown hash SHALL open Inicio (`#/home`), the default landing screen. For a role other than `project_admin` the three screens SHALL show the "sin permisos" state without calling the API.

#### Scenario: Viewer opens Actividad
- GIVEN the viewer user is selected
- WHEN opening "Actividad"
- THEN a no-permission message is shown, no request is sent to `/activity` and no error appears in the console

### Requirement: Inicio dashboard

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

The Área de preparación screen SHALL show "Abiertas" and "Cerradas (7 días)" tabs and one card per session with repository, branch, PR, status, opener, last activity, expiry or closing date and item count, each with a read-only table of items (type chip, title, operation, Juez state and criterion, item state). It SHALL indicate when the session list or a session's items were truncated. It SHALL offer no action that changes staging.

#### Scenario: Agent proposals before merge
- GIVEN an agent staged two units on `feature/login`
- WHEN the tech lead opens Área de preparación
- THEN a card for `feature/login` lists both units with state "En preparación" and Juez state "Sin evaluar"

## MODIFIED Requirements

### Requirement: Quarantine (Fig. 14)

The quarantine screen SHALL list entries with reason, unit, monospace redacted excerpt, entry date and days until expiry, filterable by reason, with View and Restore actions; the restore result SHALL appear in a toast, and the footer SHALL state that restorations are recorded as labels to measure the judge's false positives (good units the Juez held back), consistent with the Inicio indicators and the quarantine specification.

#### Scenario: Restore shows the outcome
- GIVEN a quarantine entry
- WHEN the tech lead restores it
- THEN a toast shows whether it was applied, queued or quarantined again

#### Scenario: Footer wording matches the metric definition
- GIVEN the quarantine screen
- WHEN it renders
- THEN the footer mentions "falsos positivos del Juez" and not "falsos negativos"
