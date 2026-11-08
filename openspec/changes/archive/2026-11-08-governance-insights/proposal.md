# Proposal: Governance insights — dashboard, activity and staging views

## Intent

The demo shows queues and memory, but not the *governance* itself: what the judge decided and how often humans corrected it (TT-06 with live data, not only synthetic metrics), who did what and when (the audit trail already recorded in `access_log`), and what agents proposed on each branch before the merge (staging). These three read-only views make the full lifecycle visible: propose → stage → promote → judge → human → memory.

## Scope

### In Scope
- **Inicio (dashboard)** for the project's tech lead: memories by status and type; judge outcomes (accepted / uncertain / rejected) over the last 30 days; human corrections from the stored labels (uncertain approved, judge-accepted rejected — if representable —, quarantine restored) and the derived live false-positive / false-negative indicators with their definition; queue and quarantine counts.
- **Actividad**: paginated, filterable timeline of the project's audit events (agent remember/discard, promote, judge outcome, review approve/reject, restore, direct create/amend/retire, jobs) with actor (display name or "Agente"/"CI"), action label in Spanish, target title/type when resolvable, and time. No raw query text, no secrets (audit stores hashes).
- **Área de preparación**: open (and recently closed) staging sessions per repo/branch with their items (type, title, op, judge state if evaluated, created) — read-only; excludes reserved `restore/` and `web/` sessions or labels them.
- Read-only `/api/v1/projects/:projectId/...` endpoints for the three views, project_admin only, uniform 404, audited like other reads.
- Sidebar entries and hash routes; Spanish labels; text-only rendering; tests.

### Out of Scope
- Charts libraries (plain CSS bars only), exports, cross-project views, editing staging from the web.

## Approach
New read repositories/queries over existing tables (memory, staging_session/item, quarantine, access_log) — no migrations unless an index is clearly needed for the activity query. Web screens follow the area context.

## Constraints
- No new dependencies; no schema-breaking changes; opaque errors; viewer/contributor denied (404).
- Activity must never expose raw content beyond titles already visible to the tech lead.

## Affected Areas
| Area / Module | Impact | Description |
|---|---|---|
| `src/http/api` + `src/db` | New/Modified | 3 read endpoints + queries |
| `packages/web` | New/Modified | 3 screens, sidebar, routes |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Activity query slow on large access_log | Low (demo) | project_id + time index check; page size cap |
| Metric definitions misread in the TFG | Med | Definitions shown in the UI and docs |

## Rollback Plan
Revert the change commit; read-only, no data changes.

## Success Criteria
- [ ] Three screens render with seed + `pnpm demo` data; numbers match DB queries in tests.
- [ ] Non-admins get 404 on the three endpoints.
- [ ] Suite, lint, build, typecheck:web green; screenshots updated.
