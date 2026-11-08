# Tasks: Demo UX polish, live refresh and demo helpers

> No design.md: web-only polish following the web area context.

## Phase 1: Pure helpers (TDD)
- [x] 1.1 `packages/web/src/lib/wordDiff.ts` (+ test): word-level diff returning segments `{text, kind: 'same'|'added'|'removed'}` for two strings (LCS over whitespace-split tokens, bounded input).
- [x] 1.2 `packages/web/src/lib/format.ts` (or new `lib/confidence.ts`) (+ test): `confidenceTone(confidence, threshold)` → `'ok'|'warn'`; threshold marker percentage.
- [x] 1.3 `packages/web/src/lib/shortcuts.ts` (+ test): `isEditableTarget(target)` guard.
- [x] 1.4 `packages/web/src/lib/labels.ts`: Spanish explanation per judge criterion (every criterion the API can return, incl. `stale_target`, `human_review`) as a `Record<Union,string>`.
- [x] 1.5 `packages/web/src/lib/useAsync.ts` (or `usePolling`): optional `refreshMs` with hidden-tab pause and cleanup (+ test of the scheduling logic if extractable).

## Phase 2: Screens and components
- [x] 2.1 Review detail: Spanish explanation + "Texto original del Juez"; side-by-side comparison component (text nodes only) when a related unit exists; shortcuts A/R with visible hint.
- [x] 2.2 `ConfidenceBar`: threshold marker + tone (queue + detail); threshold from API data, fallback 0.80.
- [x] 2.3 Queue table Origin column: no-wrap + ellipsis + `title`.
- [x] 2.4 Toast: success/error variants, `role` status/alert, auto-dismiss, more contrast.
- [x] 2.5 Polling 5 s on review queue, quarantine list and sidebar badges (keep filters/scroll).

## Phase 3: Demo helpers and docs
- [x] 3.1 `scripts/demo-promote.ts` + `package.json` `demo:promote` (args `--branch`, `--pr`, `BASE_URL`); `demo:reset` = `docker compose down -v && docker compose up --build -d --wait`.
- [x] 3.2 `docs/demo/INSTRUCTIVO.md`: helpers, live refresh, shortcuts; §7 agent flow uses `pnpm demo:promote`.
- [ ] 3.3 Rebuild stack, run `pnpm demo`, `pnpm smoke`, then `pnpm screenshots` to regenerate `docs/demo/capturas/*.png`.

## Phase 4: Verify remediation (round 1)
- [x] 4.1 Shortcuts (security MEDIUM): `A` arms approval → visible prompt "Pulsá A otra vez o Enter para confirmar" (role status), confirm within 3 s else disarm; `R` only focuses the reason (no keyboard reject); ignore Shift/Ctrl/Meta/Alt, `isComposing`, repeat, busy. Update hint + INSTRUCTIVO. Test the arming logic as a pure helper.
- [x] 4.2 Comparison a11y: visually hidden "(añadido)"/"(eliminado)" markers for diff segments (a `.visually-hidden` utility if none exists).
- [x] 4.3 Polling robustness: in-flight guard (skip tick while previous request pending) or sequence counter so older responses never overwrite newer; back off (double interval up to 60 s) after a failed tick, reset on success; log only the first consecutive failure; badges keep previous value on background failure. Tests for the guard/backoff logic.
- [x] 4.4 CSS tokens: replace new hard-coded colors (`.diff--added`, `.toast--error`, toast `#000`/`#fff`) with `:root` tokens.
- [x] 4.5 `scripts/demo-promote.ts`: argument errors print usage (exit 1) instead of a stack; refuse non-localhost/127.0.0.1 `BASE_URL` unless `--force`; print a formatted outcome summary (status + counts).
- [x] 4.6 Avoid duplicate error announcement (inline `role="alert"` vs error toast — keep one).
