# Delta for Governance Web

## ADDED Requirements

### Requirement: "Buscar como agente" screen

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
