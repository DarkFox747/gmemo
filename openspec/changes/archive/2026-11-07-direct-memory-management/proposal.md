# Proposal: direct-memory-management (C5) — HU-13

## Intent
The tech lead manages project memory directly from the web ("Memoria del proyecto"): browse, preview a new or edited unit against the pipeline and judge, then confirm. Writes must go through the same pipeline and apply path as agent promotions, with `web_ui` provenance.

## Scope

### In Scope (project_admin only; others get the uniform 404)
1. `GET /api/v1/projects/:projectId/memories?type=&status=&q=&cursor=` (extends C4's list): paginated (page 20), `status` ∈ active|pending_revalidation|superseded|deprecated (default active), `q` via `websearch_to_tsquery` on `content_tsv`.
2. `GET …/memories/:memoryId` → current content, fields, status, version, provenance, origin, approver, and the revision history (revision_no, op, title, author, created_at; full snapshot per revision).
3. `POST …/memories/preview {op: add|amend, type, title, summary, body, fields, targetMemoryId?, expectedRevision?, repoId?}` → runs field validation, sanitize, judge context and judge **without persisting anything**. Returns pipeline findings (categories), masked preview text, verdict, criterion, confidence vs threshold, justification, and related memory (duplicate/contradiction) with status and version.
4. `POST …/memories {…unit, confirm: true}` (add) and `PUT …/memories/:memoryId {…unit, expectedRevision, confirm: true}` (amend):
   - Create a one-item staging session `web/<userId>` on the chosen repo (default: the project's first repo) and run the **same** single-item pipeline (C3 `promoteItem`) in a **human-approved** mode.
   - Pipeline quarantine (secret → redacted + leak + alert; embedded instructions) and judge `rejected` still quarantine (HU-13.4).
   - Otherwise the tech lead's confirm **is** the human approval: applied with provenance `web_ui`, author and approver = the tech lead, version 1 (add) or a new revision with regenerated tsv and embedding (amend), even for mandatory types or uncertain verdicts.
   - Amend with a stale `expectedRevision` → 409 `{error:"Conflict", code:"target_changed"}`. `confirm` must be `true`.
5. Retire reuses C4. No second write path: SQL changes are limited to parameterizing provenance and approver in the shared apply core.

### Out of Scope
Web UI (C7), bulk import, collaborative editing.

## Decisions (auto mode)
- D1: one-item `web/<userId>` session per write (mirrors C3 restore) and a `humanApproved` option on the single-item pipeline that skips queueing (R5–R7) but never skips quarantine (pipeline, R2–R4).
- D2: repo for the session = `repoId` in the body (must belong to the project) or the project's first repo by creation.
- D3: preview is stateless and may cost one judge call; it is rate-limited by the `/api` limiter.

## Affected Areas
`src/promote/*` (extract judgeItem, humanApproved mode), `src/db/promotionRepository.ts` (provenance/approver params), new `src/db/memoryAdminRepository.ts` (list/detail/revisions), new `src/memory/directMemoryService.ts`, `src/http/api/memoryRoutes.ts`, tests, docs.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Human-approved mode becomes a bypass for agents | Med | Only reachable from the project_admin REST route; test that MCP and promotion paths never set it |
| Divergence from the promotion apply | Med | Same `promoteItem`/`applyOpInTxn`; integration tests |
| Preview costs a model call | Low | Rate limit; stub in the demo |

## Rollback Plan
Revert the commit (no schema change beyond C4's `web_ui`).

## Success Criteria
- [ ] HU-13.1–5 tests (add with web_ui/author/v1 after preview; edit → new revision and history kept, tsv+embedding regenerated; retire via C4; credential → quarantine + leak + alert; contributor/viewer denied); 409 on stale; suite, DB gate, lint, build, smoke green.
