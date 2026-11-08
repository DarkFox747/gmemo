# Archive Report: memory-lifecycle

**Archived**: 2026-11-07 | **Branch**: demo/e4 | **Final verdict**: PASS

## Shipped
- Migrations 0009/0010: `pending_revalidation`, `web_ui`, `revalidate_at`, `retired_reason`; every apply path sets the deadline (outcome never expires)
- Lifecycle API (list, confirm, retire, retire-by-pr) and the `revalidation-sweep` job + `pnpm job:revalidation`
- Per-status read-exclusion tests; reserved branches rejected on list/discard

## Specs synced
| Domain | Action | Details |
|--------|--------|---------|
| memory-lifecycle | Created | 5 requirements |
| memory-read | Updated | 1 modified (pending_revalidation hidden) |
| promotion | Updated | +1 (deadline on apply) |

## Retro
Retro skipped: auto mode, best-effort.

## Follow-ups
Audit inside the write transaction; C8 seed sets explicit deadlines (2 expired).
