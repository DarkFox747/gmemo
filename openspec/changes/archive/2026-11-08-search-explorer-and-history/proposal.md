# Proposal: Search explorer and revision history diff

## Intent

HU-08 (hybrid search with RRF) and HU-11 (corrections keep history) are core claims of the TFG, but the web cannot show them: the tech lead cannot see what an agent would get from `recall`, nor why (lexical vs semantic rank, fused score), and memory history lists revisions without showing what changed.

## Scope

### In Scope
- **Buscar como agente** screen: query, optional types and limit (5 default, max 8), optional repo; runs the same search as MCP `recall` (same service/repository code path, same `status = 'active'` filter, repo boost, RRF k=60) and shows per result: fused score, lexical rank, semantic rank (or "—"), type, title, repo; plus a note on what is excluded (superseded, deprecated, pending revalidation) and whether the embedder fell back to lexical-only.
- Read-only endpoint `GET /api/v1/projects/:projectId/search?q=&types=&limit=` (project_admin; audited with query hash like recall; zod-validated).
- **History diff** in memory detail: select two revisions (default previous vs current) and show title/summary/body/fields differences word-level, text-only (reuse the web word-diff helper from demo-ux-polish).
- Tests: endpoint (permissions, validation, parity with recall ordering on a fixture), web helpers.

### Out of Scope
- Changing the ranking algorithm; staged (draft) items in the explorer (agent-session specific); semantic quality (stub embedder declared).

## Approach
Expose rank provenance from the existing RRF fusion (`src/search/rrf.ts` / recall path) without forking it — e.g. return per-candidate lexical/semantic ranks alongside the fused list, used by both recall (ignored) and the explorer. Revision history already exists in the memory detail endpoint; the diff is web-side.

## Constraints
- One search code path for MCP and web; no ranking change (recall regression tests stay green).
- No new dependencies; opaque errors; text-only rendering.

## Affected Areas
| Area / Module | Impact | Description |
|---|---|---|
| `src/search` + recall path | Modified | rank provenance exposed |
| `src/http/api` | New | search endpoint |
| `packages/web` | New/Modified | explorer screen, history diff |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Refactor changes recall ordering | Low | Parity test vs current recall on fixtures |

## Rollback Plan
Revert the change commit; read-only.

## Success Criteria
- [ ] Explorer results equal `recall` results/order for the same query and tenant.
- [ ] History diff highlights changes between two revisions.
- [ ] Suite, lint, build, typecheck:web green.
