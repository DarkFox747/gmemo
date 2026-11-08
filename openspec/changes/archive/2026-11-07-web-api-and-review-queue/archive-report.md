# Archive Report: web-api-and-review-queue

**Archived**: 2026-11-07 | **Branch**: demo/e4 | **Final verdict**: PASS

## Shipped
- `/api/v1` REST layer with the same Gate 1/Gate 2/audit as MCP, uniform opaque errors, `/api` rate limit, dev login via `X-Dev-User` (three production guards)
- Review queue for the project_admin (list + counters, detail, approve with optional supersede, reject to quarantine) over one shared write path with first-writer-wins
- HU-04.2: `/promote` `closed_unmerged` (head_ref-bound) + GitHub workflow discard job
- Dev-only static web serving with CSP; seed demo users tl@/dev@/viewer@demo.local; smoke covers the API walk

## Specs synced
| Domain | Action | Details |
|--------|--------|---------|
| web-api | Created | 5 requirements |
| promotion | Updated | +1 (HU-04.2) |
| auth | Updated | +2 |
| http-security | Updated | +1 |

## Retro
Retro skipped: auto mode, best-effort.

## Follow-ups
R1-SEC2 dev-user allowlist; R1-SEC3 closed_unmerged residual surface; R1-SEC5 per-user limiter behind CloudFront; pre-existing `NODE_ENV` default and body parsing before limiters. The web client must send `Content-Type: application/json` on approve/reject.
