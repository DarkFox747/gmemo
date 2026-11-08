# Proposal: web-api-and-review-queue (C2) — HU-07, HU-04.2

## Intent
The governance web (C7) and the tech lead's human review (HU-07) need an authenticated REST API over the review-queue state that C1 created. HU-04.2 requires discarding a branch's staged units when its PR is closed without merging.

## Scope

### In Scope
1. **`/api/v1` router** in the same Express app.
   - Same Gate 1 + Gate 2 + audit as `/mcp`, no backdoors.
   - zod validation; dedicated `/api` rate limiter (`RATE_LIMIT_API_WINDOW_MS`/`_MAX`); `express.json` limit kept.
   - **REST error mapper**: Gate-1 failure → 401 `{error:"Unauthorized"}`; any Gate-2 denial **or** missing resource → the same 404 `{error:"Not found"}`; validation → 400 `{error:"Invalid request"}` (no echo); else 500.
2. **Dev login**: under `AUTH_DEV_BYPASS`, header `X-Dev-User: <email>`.
   - Resolved only to an existing, enabled `app_user` (seeded); absent → the default dev user; unknown → 401.
   - Same two-layer production guard, plus a test that the header is ignored or impossible in production.
3. **Identity**: `ActorIdentity` gains `userId` (`app_user.id`) for `reviewed_by`/`approved_by`. New `AuthRepository` methods: `findEnabledUserByEmail`, `listProjectsForUser`.
4. **Endpoints** (all project routes require **project_admin of `:projectId`**):
   - `GET /api/v1/me` → user (id, email, display name) and projects with role (any authenticated user).
   - `GET /api/v1/projects/:projectId/review-queue?filter=all|uncertain|mandatory&type=` → items (id, type, title, criterion, confidence, origin branch/PR, author, date) plus counters (pending, uncertain, mandatory, resolved in the last 7 days).
   - `GET …/review-queue/:itemId` → full content + fields, verdict, criterion, confidence and threshold, reason, mandatory_review, sanitize flags (categories), related units (related_memory_id and target) with status, version and origin.
   - `POST …/review-queue/:itemId/approve {markRelatedSuperseded?: boolean}` → applies through the **same** apply path as promotion (no second write path). Sets `approved_by`, `reviewed_by`, `review_decision='approved'`, `reviewed_at`. If the flag is set and a related memory exists, it becomes `superseded` with a `memory_relation`. Stale targets apply against the current revision.
   - `POST …/review-queue/:itemId/reject {reason: 3..500}` → quarantine with reason prefix `human_review`. `review_decision='rejected'`, `review_reason`, `reviewed_by`, `reviewed_at`.
   - Every read and write is audited (`read` / `update`). Resolving an already-resolved item → 404 (idempotent, opaque).
5. `review_decision` vs `judge_state` stays queryable as a label for measuring the judge (no new table).
6. **HU-04.2**: `POST /promote` accepts `event: "merged" (default) | "closed_unmerged"`.
   - `closed_unmerged` → the open session of `(repo, source_branch)` becomes `abandoned` and its non-promoted items are discarded.
   - Event-specific OIDC rules: requires `pr_number`, and the ref must be `refs/pull/<pr_number>/merge` or `refs/heads/<source_branch>`. The merged path keeps its default-branch guarantee unchanged.
   - Dev bypass works for the demo. `promote.yml` gains a `pull_request: [closed]` job guarded by `merged == false`.
7. **Static (dev only)**: `WEB_STATIC_DIR` (forbidden in production). Express serves the web build at `/` with an SPA fallback that never catches `/api`, `/mcp`, `/promote` or `/health`, and a strict self-only CSP on HTML responses only. The S3 + CloudFront production path is documented.
8. **Seed**: add `tl@demo.local` (project_admin), `dev@demo.local` (contributor), `viewer@demo.local` (viewer) so admin behaviour is exercisable now. C8 enriches the data.

### Out of Scope
Quarantine API (C3), lifecycle and revalidation (C4), direct memory management (C5), web UI (C7), real Cognito login for the web.

## Approach
A thin REST layer (`src/http/api/*`) mirrors the MCP chain as Express middleware:
- `apiAuth` (Gate 1, dev header);
- `projectAdmin` (Gate 2 on `:projectId`);
- a review-queue repository for the queue state (reads) plus the existing promotion repository for writes;
- `ReviewService.approve/reject` reusing `applyAccepted`/`quarantineItem` from C1, with the Notifier where relevant.

## Decisions (auto mode)
- D1: one Authenticator seam extended with an optional `{devUser}` input; Cognito ignores it.
- D2: 401 for authentication failures, a uniform 404 for authorization or missing resources on project routes. `/promote` keeps its current mapping (out of scope beyond the event).
- D3: `abandoned` + delete non-promoted items for `closed_unmerged` (staged content of an unmerged branch is not kept).
- D4: queue reads come from C1's state predicate, including items of still-open sessions.

## Affected Areas
| Area | Impact |
|---|---|
| `src/http` (api router, error mapper, static), `src/http/promote.ts` | New/Modified |
| `src/auth` (dev header, authorizer admin + userId, audit methods) | Modified |
| `src/db` (auth repo queries, review-queue reads, abandon session) | Modified/New |
| `src/review` (ReviewService) | New |
| `src/config`, `src/index.ts`, `src/mcp/context.ts` | Modified |
| `migrations/seed.dev.sql`, `.github/workflows/promote.yml`, docs | Modified |
| `tests/**` | New/Modified |

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Dev header backdoor | Med | Two-layer guard + test; seeded users only |
| Approve diverges from promotion apply | Med | Reuse `applyAccepted`; integration test |
| `closed_unmerged` weakens promotion guarantees | Med | Separate branch in the handler; merged path untouched; tests |
| CSP breaks the SPA or API | Low | CSP only on static HTML; tests |

## Rollback Plan
Revert the C2 commit. No schema changes besides seed rows (dev only).

## Success Criteria
- [ ] Handler tests: permissions (only project_admin; viewer/contributor/foreign → identical 404), validation, opacity.
- [ ] Integration: approve applies and creates a revision (and supersedes the related one when asked); reject creates quarantine; counters correct.
- [ ] HU-04.2: `closed_unmerged` discards and is idempotent. Dev header prod guard test.
- [ ] Suite, DB gate, lint, build, compose and smoke green.
