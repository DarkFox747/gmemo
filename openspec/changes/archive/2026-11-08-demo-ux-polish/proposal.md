# Proposal: Demo UX polish, live refresh and demo helpers

## Intent

The governance web works but, in a live demo, several things weaken the story: the judge's justification shows in English inside a Spanish UI, the contradiction between the proposal and the related unit must be compared by eye, the confidence bar is always amber and hides the threshold rule, the Origin column wraps the branch, and the screens only update on reload, so the "agent proposes → queue grows" moment needs manual refreshes. Recording takes also need one-command promote and reset.

## Scope

### In Scope
- Review detail: Spanish explanation per judge criterion (labels) shown first; the original justification kept as "Texto original del Juez"; side-by-side comparison of proposal vs related unit with word-level differences highlighted (text-only, no HTML injection).
- Confidence bar with a threshold marker; green at/above threshold, amber below (queue + detail).
- Origin column without breaking `rama · PR n` (no-wrap + ellipsis with full value in `title`).
- Keyboard shortcuts in review detail: `A` approve, `R` focus the rejection reason / reject, ignored while typing in inputs/textarea; visible hint.
- More visible toasts (success/error variants, `role="status"`/`alert`, auto-dismiss).
- Live refresh: polling (default 5 s, paused when the tab is hidden) for review queue, quarantine list and sidebar badges.
- `pnpm demo:promote -- --branch <b> [--pr <n>]` (dev OIDC bypass; feature branch requires `--pr`) and `pnpm demo:reset` (compose down -v + up --build --wait).
- Regenerate `docs/demo/capturas/*.png`; update INSTRUCTIVO.

### Out of Scope
- New screens (later changes), SSE/websockets, i18n framework, server changes.

## Approach
Web-only changes in `packages/web` following the area context (`packages/web/CLAUDE.md`, `packages/web/.claude/skills/web-area/SKILL.md`): labels in `lib/labels.ts`, pure helpers in `lib/` with unit tests (diff, threshold color, shortcut guard), polling inside the existing `useAsync` pattern. Scripts with tsx using `fetch`, no deps.

## Constraints
- No new dependencies; text-only rendering (no `dangerouslySetInnerHTML`), CSP unchanged.
- Threshold comes from the API (detail already returns it); queue uses the same value if available, else the default 0.80 documented in config.
- Polling must not leak timers and must stop when unmounted/hidden.

## Affected Areas
| Area / Module | Impact | Description |
|---|---|---|
| `packages/web` | Modified | Detail, queue, quarantine, sidebar, toasts, lib helpers |
| `scripts` + `package.json` | Modified | demo:promote, demo:reset |
| `docs/demo` | Modified | Instructions + screenshots |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Polling floods the API rate limiter | Low | 5 s interval, hidden-tab pause, one request per screen |
| Shortcut triggers approval by accident | Med | Ignore when focus is in an editable element; approve asks no confirmation only via button — shortcut A opens the same confirm path |

## Rollback Plan
Revert the change commit (web + scripts only, no data changes).

## Success Criteria
- [ ] Detail shows Spanish criterion explanation, original text, and highlighted comparison.
- [ ] Bars show threshold marker and color; Origin never wraps.
- [ ] Queue/badges update within ~5 s after `pnpm demo:promote` without reload.
- [ ] `pnpm demo:reset` and `pnpm demo:promote` work; suite, lint, build, typecheck:web, build:web green.
