# Design: Web API and human review queue (C2) — HU-07, HU-04.2

## Technical Approach

C2 adds a thin REST layer in the existing Express app and reuses the seams C0/C1 already built: Gate 1 (`Authenticator`), Gate 2 (`RdsAuthorizer`), `RdsAuditLogger`, `makeRateLimiter`, `PgPromotionRepository` and the zod config guards. No new runtime dependency is needed: `express.static`, zod, helmet and express-rate-limit are already installed (Express 5).

The REST chain mirrors the MCP tool wrapper (`src/mcp/tools/index.ts:80-87`: authenticate → resolve → authorize → audit → handler) as Express middleware:

```
/api  ──▶ apiLimiter ──▶ apiAuth (Gate 1 [+ dev header]) ──▶ /v1/me ............ authorizeUser ──▶ handler ──▶ audit
                                                     └──▶ /v1/projects/:projectId ──▶ projectAdmin (Gate 2, project_admin)
                                                                                     └──▶ review routes ──▶ ReviewService ──▶ audit
      ──▶ apiErrorHandler (mounted on '/api', before the app terminal handler)
```

The review queue is C1's **state** (no table): reads go through a new `ReviewQueueRepository`, writes go through `PgPromotionRepository`. The writes reuse the **same apply and quarantine SQL** as promotion: today's `applyAccepted`/`quarantineItem` bodies are split into transaction-scoped private cores, and promotion and review both call them. There is still one write path. Human review adds only its own lock, guard and review-column statements around those cores, in the same transaction.

`/promote` gains an `event` discriminator. The `merged` path keeps every existing check byte-for-byte. `closed_unmerged` is a separate branch with its own OIDC ref rules. It abandons the open session and deletes non-promoted items in one transaction.

In development only, `WEB_STATIC_DIR` makes Express serve the web build. It has an SPA fallback that never matches `/api`, `/mcp`, `/promote` or `/health`, and a strict CSP on HTML responses only.

**Spec alignment notes (for the orchestrator):**
- `specs/web-api` HU-07.3 says "quarantine row … with criterion `human_review`". The `quarantine` table has no criterion column yet (C3 owns `criterion`/`reason_code`), and `staging_item.judge_criterion` has a CHECK that does not allow `human_review`. C2 therefore writes `quarantine.judge_reason = 'human_review: <reason>'` (the prefix agreed in proposal item 4). C3 can backfill a criterion column from that prefix.
- Deltas are still needed for the main specs: `http-security` (an `/api` limiter, and a CSP on static HTML while the global CSP stays off) and `auth` (`ActorIdentity.userId`, the dev header, `authorizeProjectAdmin`). `specs/web-api` and the promotion delta already cover everything else.

## Architecture Decisions

### Decision: `ProjectContext` is a supertype of `TenantContext`; REST actions are their own union

**Choice** (`src/mcp/context.ts`, where every auth seam type already lives):

```ts
export interface ProjectContext { projectId: string; }
export interface TenantContext extends ProjectContext { repoId: string; branch: string; } // shape unchanged

export interface ActorIdentity {
  actorId: string;          // idp_subject (users) | OIDC repository (CI) — unchanged meaning
  userId: string | null;    // NEW: app_user.id; null on the machine (/promote) path
  roles: string[];
}
/** Actor proven to be project_admin of ProjectContext.projectId. */
export interface AdminActor extends ActorIdentity { userId: string; }
/** Gate-2-only identity for /me. */
export interface AuthenticatedUser {
  actorId: string; userId: string; email: string; displayName: string | null; globalRole: string | null;
}

/** REST audit/authorization actions — deliberately NOT part of ToolName (MCP surface unchanged). */
export type ApiAction =
  | 'me.read'
  | 'review_queue.list' | 'review_queue.read'
  | 'review_queue.approve' | 'review_queue.reject';
export interface ApiAuditDetail {
  itemId?: string; memoryId?: string; filter?: string; type?: string; resultCount?: number;
  decision?: 'approved' | 'rejected'; deduped?: boolean;
  rebasedFromRevision?: number; rebasedToRevision?: number; relatedSuperseded?: boolean;
}
```

`ToolName` is **not** widened. `RdsAuthorizer.authorize(…, tool)` keeps its `WRITE_TOOLS` gate untouched.

**Alternatives considered**: (a) widen `ToolName` with REST names. Rejected: `ToolName` drives MCP RBAC and audit typing, and the exploration flagged that widening it widens the MCP surface. (b) A synthetic `TenantContext` with an empty `repoId`/`branch`. Rejected: it lies about the shape, and `recordWrite` would store empty strings.

**Rationale**: Project routes have no repo or branch. A supertype lets every existing consumer of `TenantContext` keep compiling, and lets REST code accept only what it has.

**Reversible**: Yes. These are type-level changes, and `userId` is additive.

### Decision: Dev-user seam = optional `{devUser}` on the one `Authenticator` (D1), with a three-layer production guard

**Choice**:

```ts
export interface AuthenticateOptions {
  /** DEV ONLY. Honoured by DevAuthenticator; every other implementation MUST ignore it. */
  devUser?: string;
}
export interface Authenticator {
  authenticate(authorization: string | undefined, opts?: AuthenticateOptions): Promise<Principal>;
}
```

- `CognitoAuthenticator`: **no code change**. A method with fewer parameters satisfies the interface, so it ignores `opts` structurally.
- MCP call sites stay unchanged (one argument), so MCP never honours the header.
- `DevAuthenticator` becomes `new DevAuthenticator(users: Pick<AuthRepository, 'findEnabledUserByEmail'>)`:
  - The constructor **throws** when `process.env.NODE_ENV === 'production'`.
  - `authenticate` also throws `AppError(PERMISSION_DENIED)` at once when `process.env.NODE_ENV === 'production'`.
  - `opts?.devUser === undefined` (header absent) → `DEV_PRINCIPAL` (`dev-local-user`, the default dev user, unchanged).
  - Header present (any value, including empty) → trim and lowercase, then validate with `z.string().email().max(254)`. On failure → `PERMISSION_DENIED`.
  - Otherwise call `findEnabledUserByEmail(email)`. `null` (unknown or disabled) → `PERMISSION_DENIED`. A hit returns `{subject: u.idpSubject, clientId: 'dev-local-client', scopes: DEV_PRINCIPAL.scopes}`.
  - Gate 2 then runs **for real** on that subject, so dev login can only become a seeded, enabled user and gets that user's real memberships.
- `apiAuth` reads `X-Dev-User` (first value when repeated, like `transport.ts:40`) **only** when its factory flag `devUserHeader` is true **and** `process.env.NODE_ENV !== 'production'` at factory time. Otherwise it never forwards the header.

The production guard has three layers:
1. **Config + composition root**:
   - `AUTH_DEV_BYPASS=true` with `NODE_ENV=production` already fails `loadConfig` (`config/index.ts:99`).
   - `index.ts:63` re-checks it, so `DevAuthenticator` is never constructed in production.
   - `index.ts` passes `devUserHeader: true` only on that same dev branch.
2. **Transport**: `apiAuth` drops the header in production even if `devUserHeader: true` was passed.
3. **Authenticator**: `DevAuthenticator` refuses to construct or run in production, even if it were wired by mistake.

An unknown user → `PERMISSION_DENIED` → `apiAuth` maps **any** Gate-1 throw to `AppError(UNAUTHENTICATED)` → 401.

**Alternatives considered**: (a) A separate `DevUserResolver` seam. Rejected by D1. (b) Honour the header on `/mcp` too. Rejected (YAGNI): only the web needs to switch roles, and it would widen the backdoor surface.

**Rationale**: It follows the exact `AUTH_DEV_BYPASS` pattern (config guard plus a NODE_ENV double check) and adds two independent runtime checks, so a wiring mistake cannot open the header in production.

**Reversible**: Yes.

### Decision: Authorizer gains `authorizeProjectAdmin` and `authorizeUser`; AuthRepository gains two reads

**Choice**:

```ts
interface Authorizer {
  authorize(principal, tenant: TenantContext, tool: ToolName): Promise<ActorIdentity>;   // + userId
  authorizePromote(principal: PromotePrincipal, tenant: TenantContext): Promise<ActorIdentity>; // userId: null
  /** Gate 2 only: enabled app_user. For /me. */
  authorizeUser(principal: Principal): Promise<AuthenticatedUser>;
  /** Gate 2 + membership.role === 'project_admin' on projectId. Platform roles do NOT bypass (D4). */
  authorizeProjectAdmin(principal: Principal, projectId: string): Promise<AdminActor>;
}

interface AuthRepository {
  findEnabledUserBySubject(subject): Promise<AppUser | null>;   // AppUser += email, displayName
  findEnabledUserByEmail(email: string): Promise<{ userId: string; idpSubject: string } | null>;
  listProjectsForUser(userId: string): Promise<Array<{ projectId: string; slug: string; name: string; role: string }>>;
  // …existing methods unchanged
}
```

SQL:

```sql
-- findEnabledUserBySubject (columns added; predicate unchanged)
SELECT id, global_role, email, display_name FROM app_user WHERE idp_subject = $1 AND disabled_at IS NULL
-- findEnabledUserByEmail  ($1 already trimmed + lowercased by the caller)
SELECT id, idp_subject FROM app_user WHERE email = $1 AND disabled_at IS NULL
-- listProjectsForUser (non-archived only, per spec)
SELECT p.id, p.slug, p.name, pm.role
FROM project_membership pm JOIN project p ON p.id = pm.project_id
WHERE pm.user_id = $1 AND p.archived_at IS NULL
ORDER BY p.name, p.id
```

- `authorizeProjectAdmin` reuses `findEnabledUserBySubject` and `findMembershipRole`.
- Every failure (absent user, disabled user, no membership, role ≠ `project_admin`, DB error) throws the same `AppError(PERMISSION_DENIED)`, wrapped in the same try/catch shape as `authorize`.
- Roles are built the same way as in `authorize` (global role first, then the membership role).
- `projectId` is validated as a UUID **before** this call (in `projectAdmin`). A malformed id never reaches SQL and gets the same 404.

**Alternatives considered**: a generic `authorizeProjectRole(principal, projectId, minRole)`. Rejected (YAGNI): every C2 route needs `project_admin`. C5 can generalise it when a second role check exists.

**Rationale**: One shared RBAC library (project-map convention), the same opacity, and RDS-derived roles.

**Reversible**: Yes.

### Decision: REST error model — new `ErrorCode`s plus one `/api`-scoped error middleware; `/promote` untouched

**Choice**:
- `ErrorCode` gains `UNAUTHENTICATED` (`'Unauthorized.'`), `NOT_FOUND` (`'Not found.'`) and `INVALID_REQUEST` (`'Invalid request.'`). `OPAQUE_MESSAGES` is exhaustive. MCP never throws these codes, and `toToolErrorResult` stays unchanged.
- `src/http/api/errorHandler.ts` exports `apiErrorHandler: ErrorRequestHandler`, mounted as `app.use('/api', apiErrorHandler)` **after** the API router and **before** the existing terminal handler. It is mounted at app level rather than inside the router so that `express.json` parse errors on `/api` paths (raised before the router runs) are also mapped.

| Thrown | Status | Body (exact) | Log |
|---|---|---|---|
| `AppError(UNAUTHENTICATED)` | 401 (+ `WWW-Authenticate: Bearer`) | `{"error":"Unauthorized"}` | debug |
| `AppError(PERMISSION_DENIED \| NOT_FOUND \| CONTEXT_UNAVAILABLE \| INVALID_REFERENCE)` | 404 | `{"error":"Not found"}` | debug |
| `AppError(INVALID_REQUEST)`, or a body-parser error (`typeof err.type === 'string' && err.status` in 400–499) | 400 | `{"error":"Invalid request"}` | debug |
| `AppError(INTERNAL)` or anything else | 500 | `{"error":"Internal server error"}` | `logger.error('[api] Unhandled error', err)` |
| `res.headersSent` | — | `next(err)` | — |

- The rate limiter keeps its own 429 `{"error":"Too Many Requests"}`.
- **409** is the only status not produced by the mapper. It is an *expected outcome* of approve, not an error: the route writes `{"error":"Conflict","code":ConflictCode}` directly. `ConflictCode = 'target_changed' | 'target_inactive' | 'duplicate_content'`. It is safe to be specific here: the caller is already proven `project_admin` of the item's project.
- The API router ends with a catch-all `router.use(() => { throw new AppError(NOT_FOUND) })`, so an unknown `/api/*` path is a JSON 404 (401 if unauthenticated) and never reaches static or SPA handling.
- Every `/api` response sets `Cache-Control: no-store`.
- Validation order on project routes is apiAuth → projectAdmin → zod. A non-admin with a bad body gets 404, not 400, so validation cannot be used as an oracle.
- `/promote` keeps forwarding to the terminal 500 handler (D2).

**Alternatives considered**: (a) A REST-only `HttpError` class. Rejected: the codebase already models failures as `AppError` codes, and the exploration listed the missing `NOT_FOUND` as a gap. (b) Map 409 through `AppError` with a detail field. Rejected: it would put a per-call payload on an opaque type.

**Rationale**: One mapper defines the whole REST error vocabulary. `/promote` and `/mcp` behaviour does not change.

**Reversible**: Yes.

### Decision: Middleware chain and types

**Choice** (`src/http/api/*`):

```ts
// src/http/api/types.ts
export interface ApiLocals { principal: Principal; actor?: AdminActor; project?: ProjectContext; }
export type ApiResponse = express.Response<unknown, ApiLocals>;
export interface ApiRouterDeps {
  authenticator: Authenticator; authorizer: Authorizer; auditLogger: AuditLogger;
  authRepository: Pick<AuthRepository, 'listProjectsForUser'>;
  reviewService: ReviewServiceLike;
}
export interface ApiRouterOptions { devUserHeader: boolean; }

// apiAuth.ts
export function makeApiAuth(a: Authenticator, o: ApiRouterOptions): RequestHandler;
//   authenticate(req.headers.authorization, headerAllowed ? { devUser } : undefined)
//   → res.locals.principal; any throw → next(new AppError(UNAUTHENTICATED, err))
// projectAdmin.ts
export function makeProjectAdmin(authorizer: Authorizer): RequestHandler<{ projectId: string }>;
//   z.string().uuid() on :projectId (fail → NOT_FOUND) → authorizeProjectAdmin
//   → res.locals.actor, res.locals.project = { projectId }
// router.ts
export function makeApiRouter(deps: ApiRouterDeps, o: ApiRouterOptions): express.Router;
```

Routes (inside `makeApiRouter`, mounted at `/api`):

| Method + path | Chain | Audit (`recordApi`) |
|---|---|---|
| `GET /v1/me` | apiAuth → `authorizeUser` → `listProjectsForUser` | `me.read`, project `null` |
| `GET /v1/projects/:projectId/review-queue` | apiAuth → projectAdmin → zod query → `reviewService.list` | `review_queue.list` `{filter,type,resultCount}` |
| `GET …/review-queue/:itemId` | apiAuth → projectAdmin → uuid itemId (else 404) → `reviewService.get` (null → 404) | `review_queue.read` `{itemId}` |
| `POST …/review-queue/:itemId/approve` | apiAuth → projectAdmin → uuid → zod body → `reviewService.approve` | `review_queue.approve` (detail below) |
| `POST …/review-queue/:itemId/reject` | apiAuth → projectAdmin → uuid → zod body → `reviewService.reject` | `review_queue.reject` `{itemId, decision}` |

The project routes live on a nested router `express.Router({ mergeParams: true })` mounted at `/v1/projects/:projectId` behind `projectAdmin`.

Audit runs **after** a successful read or write, the same as `recordWrite` (Decision 6 of write-path). Denials and 404s are never audited (spec). An audit failure propagates as a 500, which is fail-closed and matches MCP.

```ts
// AuditLogger additions
recordApi(actor: ActorIdentity, project: ProjectContext | null, action: ApiAction, detail?: ApiAuditDetail): Promise<void>;
// → access_log { actor_identity: actor.actorId, actor_kind: 'user',
//                action: action ∈ {approve,reject} ? 'update' : 'read',
//                project_id, memory_id: detail.memoryId ?? null,
//                detail: { api: action, userId: actor.userId, ...detail } }   // never titles, bodies or reasons
recordAbandon(ctx: RequestContext, p: { sessionId: string; discarded: number; prNumber: number }): Promise<void>;
// → access_log { actor_kind: 'ci', action: 'delete', session_id,
//                detail: { event: 'closed_unmerged', sessionId, discarded, prNumber, repoId, branch } }
```

Zod schemas (all `.strict()`):

```ts
const QueueQuery = z.object({
  filter: z.enum(['all', 'uncertain', 'mandatory']).default('all'),
  type: z.enum(MEMORY_TYPES).optional(),                 // single source: src/mcp/tools/schemas.ts
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();                                             // arrays or unknown keys → 400
const ApproveBody = z.object({
  markRelatedSuperseded: z.boolean().default(false),
  targetRevision: z.number().int().positive().optional(), // the target version the reviewer saw
}).strict();                                              // req.body undefined → parsed as {}
const RejectBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
```

**Rationale**: Each middleware does exactly what one MCP wrapper step does. Typed `res.locals` keeps handlers free of casts.

**Reversible**: Yes.

### Decision: Review-queue reads in a dedicated `ReviewQueueRepository`; the queue predicate is C1's plus "session not abandoned"

**Choice**: `src/db/reviewQueueRepository.ts`. Every statement is scoped by `ss.project_id = $1` through the staging_session JOIN (staging_item has no project column).

The queue predicate is the same in every statement:

```sql
-- QUEUED(si, ss)
si.promoted_at IS NULL AND si.reviewed_at IS NULL AND si.judge_state <> 'rejected'
AND (si.judge_state = 'uncertain' OR si.mandatory_review) AND ss.status <> 'abandoned'
```

`ss.status <> 'abandoned'` closes a race: a `remember` that read the session id just before `closed_unmerged` could insert an orphan into the abandoned session. Open and finalized sessions are both included (D4).

Partition used by the filters and counters (it makes `pending = uncertain + mandatory`, as the spec scenario requires):
- **mandatory** = `mandatory_review`. This includes `stale_target` and accepted ≥ threshold mandatory types.
- **uncertain** = `NOT mandatory_review`, which inside the queue implies `judge_state = 'uncertain'`.

```sql
-- LIST  $1 project_id  $2 filter text  $3 type|null  $4 limit+1
SELECT si.id, si.op, si.type, si.title, si.judge_state, si.judge_criterion, si.judge_confidence,
       si.mandatory_review, ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       COALESCE(u.display_name, u.email, si.author_identity) AS author, si.created_at
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
LEFT JOIN app_user u ON u.idp_subject = si.author_identity
WHERE ss.project_id = $1 AND <QUEUED>
  AND ($2 = 'all' OR ($2 = 'uncertain' AND NOT si.mandatory_review)
                  OR ($2 = 'mandatory' AND si.mandatory_review))
  AND ($3::memory_type IS NULL OR si.type = $3::memory_type)
ORDER BY si.created_at ASC, si.id ASC
LIMIT $4                                   -- rows > limit → truncated = true, extra row dropped

-- COUNTERS  $1 project_id   (ignore filter/type: they are badge totals)
SELECT count(*) FILTER (WHERE q.queued)                                  AS pending,
       count(*) FILTER (WHERE q.queued AND NOT si.mandatory_review)      AS uncertain,
       count(*) FILTER (WHERE q.queued AND si.mandatory_review)          AS mandatory,
       count(*) FILTER (WHERE si.reviewed_at >= now() - interval '7 days') AS resolved_last_7_days
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
CROSS JOIN LATERAL (SELECT (<QUEUED>) AS queued) q
WHERE ss.project_id = $1 AND (q.queued OR si.reviewed_at >= now() - interval '7 days')
-- count(*) is bigint → pg returns a string → Number() in the mapper

-- DETAIL  $1 project_id  $2 item_id   (queued only: a resolved item gives 404)
SELECT si.id, si.op, si.type, si.title, si.summary, si.body, si.fields, si.content_hash,
       si.target_memory_id, si.target_revision, si.judge_state, si.judge_reason,
       si.judge_criterion, si.judge_confidence, si.related_memory_id, si.mandatory_review,
       si.sanitize_flags, si.author_identity, si.created_at,
       ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       COALESCE(u.display_name, u.email, si.author_identity) AS author
FROM staging_item si
JOIN staging_session ss ON ss.id = si.session_id
LEFT JOIN app_user u ON u.idp_subject = si.author_identity
WHERE ss.project_id = $1 AND si.id = $2 AND <QUEUED>

-- MEMORY REFS  $1 project_id  $2 uuid[] (non-null related_memory_id, target_memory_id)
SELECT id, type, title, summary, status, current_revision, origin_branch, origin_pr, updated_at
FROM memory WHERE project_id = $1 AND id = ANY($2::uuid[])
```

```ts
interface ReviewQueueRepository {
  listQueue(projectId: string, q: { filter: QueueFilter; type: MemoryType | null; limit: number }):
    Promise<{ rows: ReviewQueueRow[]; truncated: boolean }>;
  countQueue(projectId: string): Promise<ReviewQueueCounters>;
  findQueuedItem(projectId: string, itemId: string): Promise<ReviewItemRow | null>;
  findMemoryRefs(projectId: string, ids: string[]): Promise<MemoryRefRow[]>;   // [] → no query
}
```

No new index (the proposal fixes "no schema changes"). Pilot volumes are tiny. A partial index `ON staging_item(session_id) WHERE promoted_at IS NULL AND reviewed_at IS NULL` is the documented follow-up if the list query shows up in latency.

Judge measurement (proposal item 5) stays a plain query, because review **never overwrites `judge_state`** (see the next decision): `SELECT judge_state, judge_criterion, review_decision, count(*) … WHERE reviewed_at IS NOT NULL GROUP BY 1,2,3`.

**Alternatives considered**: put the reads on `PromotionRepository`. Rejected: that repository is the write seam of the pipeline. The proposal splits reads from writes.

**Reversible**: Yes.

### Decision: Approve/reject = transaction-scoped reuse of the promotion apply and quarantine cores, with first-writer-wins

**Choice** (`src/db/promotionRepository.ts`):

1. **Refactor without behaviour change**:
   - Extract `private applyOpInTxn(client, item, ctx, embedding): Promise<{status:'applied'; memoryId; deduped} | {status:'stale'} | {status:'duplicate'}>`. It holds today's op branches (A1/A2, M1–M3, S1–S5, D1–D3) verbatim, but it never issues BEGIN, COMMIT or ROLLBACK. The caller rolls back on `stale`/`duplicate`, and on 23505 the transaction is already aborted.
   - Extract `private insertQuarantineSnapshot(client, item, ctx, reason, redact)`, which holds today's Q1.
   - `applyAccepted` becomes: BEGIN → S0 lock → `applyOpInTxn` → `MARK_APPLIED_SQL` → COMMIT.
   - `quarantineItem` becomes: BEGIN → `insertQuarantineSnapshot` → Q2 → COMMIT.
   - `INSERT_MEMORY_SQL` (provenance `'pr_reviewed'`) and the `supersedes` relation source `'judge'` inside the supersede op stay unchanged. Human approval is recorded in `approved_by`, not in a new provenance value.
2. **Hardening bundled, so promotion cannot overwrite a human decision**:
   - `LOCK_ITEM_SQL` selects `reviewed_at` too. A reviewed row → `{status:'already'}`.
   - `RECORD_DECISION_SQL` gains `AND reviewed_at IS NULL`.
   - `MARK_QUARANTINED_SQL` gains `AND promoted_at IS NULL AND reviewed_at IS NULL`. When rowCount is 0, the quarantine transaction rolls back (no orphan snapshot) and logs `logger.warn('[promote] quarantine skipped: item resolved concurrently', { itemId })`.
3. **New methods**:

```ts
export type ConflictCode = 'target_changed' | 'target_inactive' | 'duplicate_content';
export interface ReviewApproveInput {
  projectId: string; itemId: string; reviewerUserId: string;
  expectedContentHash: string;          // hash of the row the embedding was computed from
  embedding: number[] | null;
  targetRevision: number | null;        // from the body; null = not supplied
  markRelatedSuperseded: boolean;
}
export type ReviewApproveResult =
  | { status: 'approved'; memoryId: string; deduped: boolean;
      rebasedFromRevision: number | null; rebasedToRevision: number | null; relatedSuperseded: boolean }
  | { status: 'not_found' }
  | { status: 'conflict'; code: ConflictCode };
export interface ReviewRejectInput { projectId: string; itemId: string; reviewerUserId: string; reason: string; }

approveReviewItem(i: ReviewApproveInput): Promise<ReviewApproveResult>;
rejectReviewItem(i: ReviewRejectInput): Promise<'rejected' | 'not_found'>;
abandonOpenSession(sessionId: string, projectId: string): Promise<{ abandoned: boolean; discarded: number }>;
```

**Approve transaction** (one `pool.connect()`, BEGIN … COMMIT; every early exit is a ROLLBACK):

| Step | SQL / rule | Outcome |
|---|---|---|
| R0 lock + guard | `SELECT si.<PromotionItemRow cols>, ss.id AS session_id, ss.repo_id, ss.branch, ss.pr_number FROM staging_item si JOIN staging_session ss ON ss.id = si.session_id WHERE si.id=$1 AND ss.project_id=$2 AND <QUEUED> FOR UPDATE OF si` | 0 rows → `not_found`. Under READ COMMITTED, a concurrent committed approve/reject re-evaluates the predicate on the new row version and excludes it, so the **first writer wins** and the loser gets 404 |
| R1 target (op ≠ add) | `LOCK_MEMORY_SQL` (`… WHERE id=$t AND project_id=$p FOR UPDATE`) | missing, `target_memory_id` null, or `status ≠ 'active'` → `conflict target_inactive` |
| R2 revision check | `cur = current_revision`. If `input.targetRevision !== null && input.targetRevision !== cur` → `conflict target_changed`. If `cur !== item.target_revision` (stale) and `input.targetRevision !== cur` → `conflict target_changed` | the reviewer must confirm the version they saw |
| R3 rebase (stale and confirmed) | `UPDATE staging_item SET target_revision = $cur WHERE id = $i`; `item.target_revision = cur` | `rebasedFrom = old`, `rebasedTo = cur` |
| R4 embedding | `row.content_hash === expectedContentHash ? input.embedding : null` (a concurrent `persistMasked` changed the content → fail-soft null, `logger.warn` with the itemId) | — |
| R5 apply | `applyOpInTxn(client, item, ctx, embedding)` with `ctx = {projectId, repoId: ss.repo_id, originBranch: ss.branch, originPr: ss.pr_number, sessionId}` | `stale` (unreachable after R1–R3, defensive) → `conflict target_changed`. `duplicate` → `conflict duplicate_content` |
| R6 mark | `UPDATE staging_item SET promoted_at=now(), promoted_memory_id=$m, reviewed_by=$u, review_decision='approved', reviewed_at=now() WHERE id=$i AND promoted_at IS NULL AND reviewed_at IS NULL` — **`judge_state` is not touched** (it keeps the judge's label) | rowCount 0 → `not_found` |
| R7 approver | when `!deduped`: `UPDATE memory SET approved_by=$u WHERE id=$m AND project_id=$p` (a dedup leaves the existing memory's approver untouched) | — |
| R8 related | when `markRelatedSuperseded && related_memory_id && op ≠ 'deprecate' && related_memory_id ≠ m`: `UPDATE memory SET status='superseded', updated_at=now() WHERE id=$r AND project_id=$p AND status='active'`. If rowCount = 1: `INSERT INTO memory_relation (from_memory,to_memory,relation_type,source) VALUES ($m,$r,'supersedes','human') ON CONFLICT (from_memory,to_memory,relation_type) DO NOTHING` | `relatedSuperseded = rowCount === 1`. When the flag cannot apply it is reported as `false`, never silently dropped |

Lock order is item → target memory → related memory, the same order as `applyAccepted` (item → memory), so there is no lock-order inversion.

How each item class is handled:
- **Mandatory accepted** (R7 of C1) and **uncertain** (R1/R5/R6 of C1) both go through R0–R8 unchanged. The human decision is what authorises the apply.
- **stale_target** (or any target that moved after queueing) goes through R2/R3. The apply goes against the **current** revision only when the reviewer echoes it back as `targetRevision`. The detail DTO shows `target.version`, which the UI sends back. A target that moved again between view and approve gives 409 `target_changed`, so the reviewer reloads. Nothing changes on a conflict, and the item stays queued. The rebase is audited as `{rebasedFromRevision, rebasedToRevision}`, and the staging row keeps the revision that was really applied.
- **Duplicates**:
  - An `add` whose hash already exists in memory → `applied, deduped:true`. This is the promotion behaviour: the item points at the existing memory.
  - An `amend` that collides (23505), or a `supersede` that resolves to its own target → 409 `duplicate_content`. The item stays queued, and the reviewer rejects it.

**Reject transaction**:
- R0 (same lock and guard) → `not_found`.
- `insertQuarantineSnapshot(client, item, ctx, 'human_review: ' + reason, redact=false)`. Queued items never contain secrets (sanitize quarantines those before they can queue), and PII is already masked.
- `UPDATE staging_item SET reviewed_by=$u, review_decision='rejected', review_reason=$reason, reviewed_at=now() WHERE id=$i AND promoted_at IS NULL AND reviewed_at IS NULL`. rowCount 0 → ROLLBACK, `not_found`.
- `judge_state` is not touched.

**Alternatives considered**:
- (a) Have ReviewService call the public `applyAccepted` and then a separate review UPDATE. Rejected: there are two transactions, so a concurrent reject could quarantine an item that was just applied (`MARK_QUARANTINED_SQL` had no guard), and `MARK_APPLIED_SQL` overwrites `judge_state='accepted'`, which destroys the judge label that proposal item 5 needs.
- (b) Copy the op SQL into a "review apply". Rejected: it is a second write path (proposal risk "approve diverges from promotion apply").
- (c) Silently rebase stale targets without confirmation. Rejected: a human would overwrite a revision they never saw (lost update).

**Rationale**: Same SQL, one transaction, one row lock, and a guard on `reviewed_at IS NULL` in both the lock and the final UPDATE. That gives idempotent 404s and first-writer-wins with no new schema.

**Reversible**: Partial. This is an internal repository interface, and all consumers are in this repo. Data written (memories, revisions, review columns) follows the normal memory lifecycle.

### Decision: `ReviewService` orchestrates and maps; no notifier events

**Choice** (`src/review/reviewService.ts`):

```ts
export interface ReviewServiceDeps {
  reviewQueueRepository: ReviewQueueRepository;
  promotionRepository: Pick<PromotionRepository, 'approveReviewItem' | 'rejectReviewItem'>;
  embedder: Embedder;
  confidenceThreshold: number;                 // config.JUDGE_CONFIDENCE_THRESHOLD (C1)
}
export type ApproveOutcome =
  | { kind: 'approved'; dto: ApproveResponseDto; audit: ApiAuditDetail }
  | { kind: 'not_found' } | { kind: 'conflict'; code: ConflictCode };
export type RejectOutcome =
  | { kind: 'rejected'; dto: RejectResponseDto } | { kind: 'not_found' } | { kind: 'invalid_reason' };
export interface ReviewServiceLike {
  list(projectId: string, q: QueueQueryInput): Promise<ReviewQueueListDto>;
  get(projectId: string, itemId: string): Promise<ReviewItemDetailDto | null>;
  approve(actor: AdminActor, projectId: string, itemId: string, b: ApproveInput): Promise<ApproveOutcome>;
  reject(actor: AdminActor, projectId: string, itemId: string, b: RejectInput): Promise<RejectOutcome>;
}
```

- `get`: `findQueuedItem`, then `findMemoryRefs([related, target])`. It sets `targetStale = target === null || target.status !== 'active' || target.version !== item.target_revision` when the op is not `add`.
- `approve`:
  1. `findQueuedItem` (null → `not_found`).
  2. `embedding = await embedItemFailSoft(embedder, item)`. This is a new helper in `src/embedder/embedder.ts` (null for `deprecate`, warn plus null on throw), extracted from `promoteService.ts:174-186`, which then calls it. That makes two real users.
  3. `approveReviewItem({…, expectedContentHash: item.content_hash})` and map the result.
- `reject`:
  - Body already zod-validated (3..500 after trim).
  - `scanForSecrets(reason).length > 0` → `invalid_reason` → 400 (never echoed, never stored).
  - `reason = maskPii(reason).text`.
  - `rejectReviewItem` (`'not_found'` → `not_found`).
- **Notifier**: none. C1's `NotifyEvent` covers *entering* the queue and leaks. Resolution is the human's own action and is audited. `NotifyEvent` is not widened (YAGNI), and `Notifier` is not a dependency.

**Rationale**: Pure orchestration over two repositories, so it is unit-testable with fakes. Routes stay thin and own the audit, as the MCP wrappers do.

**Reversible**: Yes.

### Decision: `/promote` event discriminator; `closed_unmerged` is a separate branch with PR-bound OIDC rules

**Choice** (`src/http/promote.ts`):

```ts
const PromoteBody = z.object({
  repo: z.string().min(1),
  source_branch: z.string().min(1),
  pr_number: z.number().int().positive().optional(),
  merge_sha: z.string().min(1).optional(),
  event: z.enum(['merged', 'closed_unmerged']).default('merged'),
}).strict().superRefine((b, ctx) => {
  if (b.event === 'closed_unmerged' && (b.pr_number === undefined || b.merge_sha !== undefined))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid' });
});
```

OIDC seam (same pattern as D1):
- `OidcVerifier.verify(authorization, opts?: { devRef?: string })`. `PromotePrincipal` gains `headRef: string | null`.
- `GithubOidcAuthenticator` ignores `opts`. It extracts the optional `head_ref` claim, which GitHub sets for `pull_request` workflows (`''` → null).
- `DevOidcAuthenticator` returns `{ repository: DEV, ref: opts?.devRef ?? 'refs/heads/main', headRef: null }`. The handler always passes `devRef: 'refs/heads/' + body.source_branch`.
- On the merged path this changes nothing observable. A feature branch is still denied, now by the default-branch check instead of the ref check. Dev stays prod-guarded by the existing `PROMOTE_OIDC_DEV_BYPASS` double guard.

Handler order:
1. Body parse.
2. `verify`.
3. `body.repo === principal.repository`.
4. Branch on `event`.

`merged`: steps 3.5 to 9 exactly as today (`ref == source_branch`, `findRepoByGithubSlug`, `source_branch == default_branch`, `authorizePromote`, session, `promote`).

`closed_unmerged`:

| # | Rule | Fail |
|---|---|---|
| C1 | `principal.ref === 'refs/pull/' + pr_number + '/merge' && principal.headRef === source_branch` **or** `principal.ref === 'refs/heads/' + source_branch` | PERMISSION_DENIED |
| C2 | `findRepoByGithubSlug(principal.repository)` exists | PERMISSION_DENIED |
| C3 | `source_branch !== repo.defaultBranch` (closed_unmerged can never touch the default branch's session) | PERMISSION_DENIED |
| C4 | `authorizePromote(principal, tenant)` (active machine_credential) | PERMISSION_DENIED |
| C5 | `findOpenSessionId(tenant)` is null → `200 {"status":"no_op","discarded":0}` | — |
| C6 | `abandonOpenSession(sessionId, projectId)`; `abandoned:false` (raced) → the same `no_op` body | — |
| C7 | `auditLogger.recordAbandon(ctx, {sessionId, discarded, prNumber})` → `200 {"status":"abandoned","discarded":n}` | — |

Abandon transaction:

```sql
-- $1 session_id  $2 project_id
UPDATE staging_session SET status = 'abandoned', last_activity_at = now()
WHERE id = $1 AND project_id = $2 AND status = 'open'          -- rowCount 0 → ROLLBACK, {false, 0}
DELETE FROM staging_item WHERE session_id = $1 AND promoted_at IS NULL   -- rowCount = discarded
```

- This deletes every non-promoted item (D3 and the spec), including judge- or human-rejected rows. Their quarantine snapshots survive (no FK), and human decisions survive in `access_log`.
- Promoted rows are kept, because `memory_revision.promoted_from_item` points at them.
- A concurrent approve holds `FOR UPDATE` on its item. The DELETE waits, then re-checks `promoted_at IS NULL` and skips the approved row. If the DELETE goes first, the approve's R0 finds no row → 404.

`head_ref` binding is **added** to the proposal's ref rule. Without it, a workflow on PR #N (whose YAML the PR author controls) could name any `source_branch` and wipe another branch's staged items. The residual risk is that a PR author can discard their *own* head branch's staging, which is acceptable.

**`promote.yml`** (sketch; the existing push job is unchanged apart from its `if`):

```yaml
on:
  push:
    branches: [main]
  pull_request:
    types: [closed]

jobs:
  promote:
    if: github.event_name == 'push'
    # …unchanged…
  discard:
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.merged == false &&
      github.event.pull_request.head.repo.full_name == github.repository   # forks get no id-token
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Mint OIDC token
        id: tok
        # actions/github-script v7.0.1 — pinned to full commit SHA (same pin as the promote job).
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea
        env:
          GMEMO_OIDC_AUDIENCE: ${{ vars.GMEMO_OIDC_AUDIENCE }}
        with:
          script: |
            const token = await core.getIDToken(process.env.GMEMO_OIDC_AUDIENCE);
            core.setSecret(token);
            core.setOutput('token', token);
      - name: POST /promote (closed_unmerged)
        env:
          OIDC_TOKEN: ${{ steps.tok.outputs.token }}
          PROMOTE_URL: ${{ vars.GMEMO_PROMOTE_URL }}
          GH_REPOSITORY: ${{ github.repository }}
          GH_HEAD_REF: ${{ github.event.pull_request.head.ref }}   # untrusted → env + jq --arg only
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          curl --silent --show-error --fail-with-body --request POST --url "${PROMOTE_URL}" \
            --header "Authorization: Bearer ${OIDC_TOKEN}" --header "Content-Type: application/json" \
            --data "$(jq --null-input --arg repo "${GH_REPOSITORY}" --arg source_branch "${GH_HEAD_REF}" \
              --argjson pr_number "${PR_NUMBER}" \
              '{repo:$repo, source_branch:$source_branch, pr_number:$pr_number, event:"closed_unmerged"}')"
```

**Dev demo**: under `PROMOTE_OIDC_DEV_BYPASS`, `curl -X POST :3000/promote -d '{"repo":"crombie-llc/gmemo-demo","source_branch":"feature/x","pr_number":7,"event":"closed_unmerged"}'` works with the seeded machine_credential (dev ref = `refs/heads/feature/x`).

**Alternatives considered**: (a) A separate `/promote/close` endpoint. Rejected: the proposal fixes the discriminator, and a second endpoint would duplicate the OIDC and credential chain. (b) Relax the merged path's ref check. Rejected: it would weaken the default-branch guarantee.

**Reversible**: Yes. `event` is additive with a default.

### Decision: Dev-only static serving with an HTML-only CSP

**Choice**:
- Config: `WEB_STATIC_DIR: z.string().min(1).optional()`, plus a superRefine guard `WEB_STATIC_DIR && NODE_ENV === 'production'` → issue on `WEB_STATIC_DIR`.
- `index.ts` double check: it passes `webStaticDir` to `createApp` only when `NODE_ENV !== 'production'`.
- `src/http/static.ts`:

```ts
export const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const NOT_SPA = /^\/(?:api|mcp|promote|health)(?:\/|$)/;
export function mountWebStatic(app: express.Express, dir: string): void;
//  - throws at boot if <dir>/index.html is missing (fail fast)
//  - app.use(express.static(dir, { index: 'index.html', dotfiles: 'ignore', redirect: false,
//        setHeaders: (res, file) => { if (file.endsWith('.html')) { res.set('Content-Security-Policy', WEB_CSP);
//                                                                 res.set('Cache-Control', 'no-cache'); } } }))
//  - SPA fallback middleware: only GET/HEAD, !NOT_SPA.test(req.path), path.extname(req.path) === ''
//        → set the same CSP + no-cache, res.sendFile('index.html', { root: dir }); otherwise next()
```

- Registration order in `createApp`: helmet → json → `/health` → `/mcp` → `/promote` → `app.use('/api', [apiLimiter], apiRouter)` → `app.use('/api', apiErrorHandler)` → `mountWebStatic` (if configured) → terminal handler.
- Global helmet keeps `contentSecurityPolicy: false`, so JSON and MCP responses are unaffected.
- No CORS is needed: the web is served same-origin.
- No cookies are used (Bearer or dev header), so CSRF does not apply.
- Production path (documented in DEVELOPMENT.md): the web build goes to S3 behind CloudFront, with an `/api/*` behaviour forwarded to the ALB (same origin). The CSP is set as a CloudFront response-headers policy.

**Alternatives considered**: enable helmet CSP globally. Rejected: the spec (`http-security`) keeps the API CSP off, and the CSP is only meaningful on documents.

**Reversible**: Yes.

### Decision: `/api` rate limit and config

**Choice**:
- `RATE_LIMIT_API_WINDOW_MS` (default 60000) and `RATE_LIMIT_API_MAX` (default 120) use `z.coerce.number().int().min(1)`, like the existing `RATE_LIMIT_*` variables.
- `RateLimitOptions` gains `apiWindowMs` and `apiMax`.
- One `makeRateLimiter` instance is mounted before `apiAuth` on `/api` when `rl.enabled`, so unauthenticated floods are limited too.
- The existing `RATE_LIMIT_ENABLED` production guard covers it, so no new guard is needed. `rateLimitGuard.test.ts` gains the API cases.

`createApp` options become `{ rateLimit?, devUserHeader?: boolean /* default false */, webStaticDir?: string }`.

**Reversible**: Yes.

### Decision: Seed — three demo users on the existing project

**Choice** (appended to `migrations/seed.dev.sql`; idempotent; fixed UUIDs; ids that leave room for C8):

```sql
-- 9) Demo users for the web/API (C2). Use them via the X-Dev-User header under AUTH_DEV_BYPASS.
--    C8 adds project "Portal de Clientes" and enriches the data; ids 0005-0009 / 0034-0039 are left free.
INSERT INTO app_user (id, idp_subject, email, display_name, global_role) VALUES
  ('00000000-0000-0000-0000-000000000002', 'demo-tl',     'tl@demo.local',     'Tech Lead (demo)', NULL),
  ('00000000-0000-0000-0000-000000000003', 'demo-dev',    'dev@demo.local',    'Developer (demo)', NULL),
  ('00000000-0000-0000-0000-000000000004', 'demo-viewer', 'viewer@demo.local', 'Viewer (demo)',    NULL)
ON CONFLICT (idp_subject) DO NOTHING;

INSERT INTO project_membership (id, project_id, user_id, role, granted_by) VALUES
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000002', 'project_admin', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000003', 'contributor',   '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000004', 'viewer',        '00000000-0000-0000-0000-000000000001')
ON CONFLICT (project_id, user_id) DO NOTHING;
```

The default dev user (`dev@localhost`, contributor) is unchanged. Without the header it can call `/me`, but it gets 404 on project routes.

**Reversible**: Yes (dev-only rows).

## Data Flow

```
Browser (dev) ── X-Dev-User / Bearer ─▶ /api ─▶ apiLimiter ─▶ apiAuth ──(throw)──▶ 401
                                                    │ principal
                       /v1/me ◀────────────────────┤
                         authorizeUser → listProjectsForUser → recordApi(me.read) → 200 MeDto
                       /v1/projects/:projectId ─▶ projectAdmin ──(deny|bad uuid)──▶ 404
                                                    │ AdminActor, ProjectContext
                       review routes ─▶ zod (400) ─▶ ReviewService
                           list/get ─▶ ReviewQueueRepository (project-scoped, QUEUED) ─▶ recordApi(read)
                           approve ─▶ findQueuedItem ─▶ embedItemFailSoft ─▶ PromotionRepository.approveReviewItem
                                         BEGIN R0 lock+guard → R1 target lock → R2/R3 rebase?
                                               → R5 applyOpInTxn (same SQL as promotion) → R6 mark reviewed
                                               → R7 approved_by → R8 supersede related? COMMIT
                                      ─▶ 200 | 404 | 409{code} ─▶ recordApi(update)
                           reject  ─▶ secret-scan + PII-mask reason ─▶ rejectReviewItem
                                         BEGIN R0 → insertQuarantineSnapshot('human_review: …') → mark reviewed COMMIT
                                      ─▶ 200 | 404 ─▶ recordApi(update)
                     errors ─▶ apiErrorHandler (401/404/400/500)

GitHub pull_request closed (merged=false) ─▶ POST /promote {event:closed_unmerged, pr_number}
   ─▶ verify(OIDC, devRef) ─▶ repo claim ─▶ ref = refs/pull/N/merge & head_ref = source_branch | refs/heads/source_branch
   ─▶ repo ≠ default branch ─▶ authorizePromote ─▶ findOpenSessionId ─(none)─▶ no_op
   ─▶ abandonOpenSession: UPDATE session→abandoned + DELETE non-promoted items (1 txn) ─▶ recordAbandon ─▶ 200
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `ProjectContext`, `TenantContext extends ProjectContext` | type | `src/mcp/context.ts` | `src/http/api/projectAdmin.ts`, `src/http/api/reviewRoutes.ts`, `src/auth/auditLogger.ts`, C3–C7 routes |
| `ActorIdentity.userId`, `AdminActor`, `AuthenticatedUser` | type | `src/mcp/context.ts` | `src/auth/authorizer.ts`, `src/review/reviewService.ts`, `src/http/api/meRoutes.ts`, `tests/auth/fakes.ts` |
| `AuthenticateOptions`, `Authenticator.authenticate(auth, opts?)` | interface | `src/mcp/context.ts` | `src/auth/devAuthenticator.ts`, `src/http/api/apiAuth.ts` |
| `ApiAction`, `ApiAuditDetail`, `AuditLogger.recordApi`, `AuditLogger.recordAbandon` | type / interface | `src/mcp/context.ts` | `src/auth/auditLogger.ts`, `src/http/api/*.ts`, `src/http/promote.ts`, C3–C7 (extend `ApiAction`) |
| `Authorizer.authorizeProjectAdmin`, `Authorizer.authorizeUser` | interface | `src/mcp/context.ts` | `src/auth/authorizer.ts`, `src/http/api/projectAdmin.ts`, `src/http/api/meRoutes.ts` |
| `AuthRepository.findEnabledUserByEmail`, `listProjectsForUser`, `AppUser.email/displayName` | interface | `src/db/authRepository.ts` | `src/auth/devAuthenticator.ts`, `src/auth/authorizer.ts`, `src/http/api/meRoutes.ts`, `tests/auth/fakes.ts` |
| `ErrorCode.UNAUTHENTICATED / NOT_FOUND / INVALID_REQUEST` | enum | `src/errors/appError.ts` | `src/http/api/*.ts`, C3–C7 |
| `ApiErrorBody`, `ConflictCode` | type | `src/http/api/types.ts` | `src/http/api/errorHandler.ts`, `src/http/api/reviewRoutes.ts`, `packages/web` (C7) |
| `ApiLocals`, `ApiRouterDeps`, `ApiRouterOptions` | type | `src/http/api/types.ts` | `src/http/api/*.ts`, `src/http/app.ts` |
| `makeApiAuth`, `makeProjectAdmin`, `makeApiRouter`, `apiErrorHandler` | func | `src/http/api/apiAuth.ts`, `src/http/api/projectAdmin.ts`, `src/http/api/router.ts`, `src/http/api/errorHandler.ts` | `src/http/app.ts`, C3–C7 (mount further project routes on the router) |
| `MeDto`, `ReviewQueueItemDto`, `ReviewQueueCountersDto`, `ReviewQueueListDto`, `MemoryRefDto`, `ReviewItemDetailDto`, `ApproveResponseDto`, `RejectResponseDto` | type | `src/http/api/types.ts` | `src/review/reviewService.ts`, `src/http/api/reviewRoutes.ts`, `packages/web` (C7) |
| `ReviewQueueRepository`, `PgReviewQueueRepository`, row types | interface / class | `src/db/reviewQueueRepository.ts` | `src/review/reviewService.ts`, `src/index.ts` |
| `ReviewApproveInput`, `ReviewApproveResult`, `ReviewRejectInput`, `approveReviewItem`, `rejectReviewItem`, `abandonOpenSession` | type / interface | `src/db/promotionRepository.ts` | `src/review/reviewService.ts`, `src/http/promote.ts`, `tests/promote/fakes.ts`, `tests/http/promote.test.ts` |
| `ReviewServiceLike`, `ReviewService`, `ApproveOutcome`, `RejectOutcome` | interface / class | `src/review/reviewService.ts` | `src/http/api/reviewRoutes.ts`, `src/mcp/context.ts` (`AppServices.reviewService`), `src/index.ts` |
| `embedItemFailSoft` | func | `src/embedder/embedder.ts` | `src/promote/promoteService.ts`, `src/review/reviewService.ts` |
| `PromotePrincipal.headRef`, `OidcVerifier.verify(auth, opts?)` | type / interface | `src/auth/oidcAuthenticator.ts` | `src/auth/devOidcAuthenticator.ts`, `src/http/promote.ts` |
| `mountWebStatic`, `WEB_CSP` | func / const | `src/http/static.ts` | `src/http/app.ts` |
| `Config.WEB_STATIC_DIR`, `RATE_LIMIT_API_WINDOW_MS`, `RATE_LIMIT_API_MAX` | config | `src/config/index.ts` | `src/index.ts` |

DTO shapes (exact, camelCase JSON; ISO-8601 strings for timestamps):

```ts
type ApiErrorBody =
  | { error: 'Unauthorized' | 'Not found' | 'Invalid request' | 'Internal server error' | 'Too Many Requests' }
  | { error: 'Conflict'; code: ConflictCode };
interface MeDto { user: { id: string; email: string; displayName: string | null };
                  projects: Array<{ id: string; slug: string; name: string; role: string }> }
interface ReviewQueueItemDto { id: string; op: 'add'|'amend'|'supersede'|'deprecate'; type: MemoryType; title: string;
  judgeState: 'pending'|'accepted'|'uncertain'; criterion: DecisionCriterion | null; confidence: number | null;
  mandatoryReview: boolean; originBranch: string; originPr: number | null; author: string; createdAt: string }
interface ReviewQueueCountersDto { pending: number; uncertain: number; mandatory: number; resolvedLast7Days: number }
interface ReviewQueueListDto { items: ReviewQueueItemDto[]; counters: ReviewQueueCountersDto; truncated: boolean }
interface MemoryRefDto { id: string; type: MemoryType; title: string; summary: string;
  status: 'active'|'superseded'|'deprecated'; version: number; originBranch: string | null;
  originPr: number | null; updatedAt: string }
interface ReviewItemDetailDto extends ReviewQueueItemDto { summary: string; body: string;
  fields: Record<string, unknown>; reason: string | null; threshold: number;
  sanitizeFlags: { pii?: string[]; injection?: string[]; secrets?: string[]; leak?: true };
  targetRevision: number | null; target: MemoryRefDto | null; related: MemoryRefDto | null; targetStale: boolean }
interface ApproveResponseDto { itemId: string; decision: 'approved'; memoryId: string; deduped: boolean;
  rebasedFromRevision: number | null; relatedSuperseded: boolean }
interface RejectResponseDto { itemId: string; decision: 'rejected' }
```

## File Changes

Batches: **A** first. Then **B** and **C** in parallel (both need A). **D** needs C. **E** needs B and C, and runs in parallel with D. **F** needs B and D. **G** needs E and F. **H** (docs) can run with G. A file that appears in two batches is touched sequentially (A→G for `context.ts`, B→G for `tests/auth/fakes.ts`).

| File | Action | Description |
|------|--------|-------------|
| **A — Contracts, errors, config** | | |
| `src/mcp/context.ts` | Modify | `ProjectContext` (+`TenantContext extends`), `ActorIdentity.userId`, `AdminActor`, `AuthenticatedUser`, `AuthenticateOptions` + `authenticate(auth, opts?)`, `ApiAction`, `ApiAuditDetail`, `Authorizer.authorizeUser/authorizeProjectAdmin`, `AuditLogger.recordApi/recordAbandon` |
| `src/errors/appError.ts` | Modify | `UNAUTHENTICATED`, `NOT_FOUND`, `INVALID_REQUEST` + opaque messages |
| `src/http/api/types.ts` | Create | `ApiLocals`, `ApiResponse`, `ApiRouterDeps`, `ApiRouterOptions`, `ApiErrorBody`, `ConflictCode` (re-export), all DTOs |
| `src/config/index.ts` | Modify | `WEB_STATIC_DIR` + prod guard; `RATE_LIMIT_API_WINDOW_MS`, `RATE_LIMIT_API_MAX` |
| `tests/config/webConfig.test.ts` | Create | `WEB_STATIC_DIR` + production → exit(1); allowed in development; absent by default |
| `tests/config/rateLimitGuard.test.ts` | Modify | API defaults 60000/120; `RATE_LIMIT_API_MAX=0` → exit(1); prod guard still covers `/api` |
| **B — Auth implementations + seed** | | |
| `src/db/authRepository.ts` | Modify | `AppUser` + `email`, `displayName`; `findEnabledUserByEmail`; `listProjectsForUser` (non-archived) |
| `src/auth/devAuthenticator.ts` | Modify | Repository-backed `devUser` lookup; default principal; production refusal in ctor and in `authenticate` |
| `src/auth/authorizer.ts` | Modify | `userId` in `authorize` (`user.userId`) and `authorizePromote` (`null`); `authorizeUser`; `authorizeProjectAdmin` |
| `src/auth/auditLogger.ts` | Modify | `recordApi` (read/update mapping, no content), `recordAbandon` (ci/delete) |
| `migrations/seed.dev.sql` | Modify | Section 9: three demo users + memberships (SQL above) |
| `tests/auth/fakes.ts` | Modify | `InMemoryAuthRepository`: email/displayName on `FakeUser`, `findEnabledUserByEmail`, `listProjectsForUser` (+ `FakeProject`); `STUB_ACTOR.userId`; stub authorizer/audit new methods |
| `tests/auth/devAuthenticator.test.ts` | Modify | Absent → `DEV_PRINCIPAL`; known email (case-insensitive) → that subject; unknown, disabled, malformed or empty → PERMISSION_DENIED; ctor and `authenticate` refuse under `NODE_ENV=production` |
| `tests/auth/authorizer.test.ts` | Modify | `userId` returned; `authorizePromote` → `userId: null` |
| `tests/auth/authorizeProjectAdmin.test.ts` | Create | admin ok; contributor, viewer, service_agent, no membership, disabled, absent, platform_admin without membership → identical PERMISSION_DENIED; `authorizeUser` |
| `tests/auth/auditLogger.test.ts` | Modify | `recordApi` action mapping, `project_id` null for `me.read`, detail has no content; `recordAbandon` row |
| `tests/db/authRepository.integration.test.ts` | Create | DB-gated: email lookup excludes disabled users; `listProjectsForUser` excludes archived projects; seed users resolve |
| **C — DB layer** | | |
| `src/db/promotionRepository.ts` | Modify | Extract `applyOpInTxn` + `insertQuarantineSnapshot`; guards (`LOCK_ITEM` reviewed, `RECORD_DECISION` and `MARK_QUARANTINED` `reviewed_at IS NULL` + rowCount handling); `approveReviewItem`, `rejectReviewItem`, `abandonOpenSession` + types |
| `src/db/reviewQueueRepository.ts` | Create | `ReviewQueueRepository` + `PgReviewQueueRepository` (LIST/COUNTERS/DETAIL/MEMORY REFS SQL) |
| `tests/promote/fakes.ts` | Modify | `FakePromotionRepository` implements the 3 new methods (stateful, enough for D/E unit tests) |
| `tests/db/review.integration.test.ts` | Create | DB-gated approve/reject end to end (see Test Strategy) |
| `tests/db/reviewQueue.integration.test.ts` | Create | DB-gated list/filter/counters/detail/tenant isolation |
| `tests/db/promotion.integration.test.ts` | Modify | Refactor regression (all ops unchanged); guard regressions; `abandonOpenSession` |
| **D — Review service** | | |
| `src/review/reviewService.ts` | Create | `ReviewService`, `ReviewServiceLike`, outcomes, DTO mapping, reason secret-scan + PII mask |
| `src/embedder/embedder.ts` | Modify | `embedItemFailSoft(embedder, item)` |
| `src/promote/promoteService.ts` | Modify | Use `embedItemFailSoft` (behaviour identical) |
| `tests/review/fakes.ts` | Create | `FakeReviewQueueRepository`, scripted approve/reject results, fake embedder |
| `tests/review/reviewService.test.ts` | Create | Mapping, embedding fail-soft, reason handling, `targetStale` |
| `tests/embedder/failSoft.test.ts` | Modify | `embedItemFailSoft`: deprecate → null without a call; throw → null + warn |
| **E — `/promote` closed_unmerged** | | |
| `src/auth/oidcAuthenticator.ts` | Modify | `PromotePrincipal.headRef`; `verify(auth, opts?)`; extract `head_ref` |
| `src/auth/devOidcAuthenticator.ts` | Modify | Honour `opts.devRef`; `headRef: null` |
| `src/http/promote.ts` | Modify | `event` + superRefine; `closed_unmerged` branch C1–C7; merged branch unchanged |
| `.github/workflows/promote.yml` | Modify | `pull_request: [closed]` trigger, `if` on the existing job, new `discard` job (sketch above, SHA-pinned) |
| `tests/http/promote.test.ts` | Modify | Fake repo literal + new methods; HU-04.2 cases |
| `tests/auth/oidc.test.ts` | Modify | `head_ref` extracted / absent → null; dev `devRef` honoured |
| **F — REST routers + static** | | |
| `src/http/api/errorHandler.ts` | Create | `apiErrorHandler` (table above) |
| `src/http/api/apiAuth.ts` | Create | `makeApiAuth` (header gate + UNAUTHENTICATED mapping) |
| `src/http/api/projectAdmin.ts` | Create | `makeProjectAdmin` (uuid → 404, `authorizeProjectAdmin`) |
| `src/http/api/meRoutes.ts` | Create | `GET /v1/me` |
| `src/http/api/reviewRoutes.ts` | Create | 4 review routes, zod schemas, 409 writer, audit calls |
| `src/http/api/router.ts` | Create | `makeApiRouter` (no-store, apiAuth, me, nested project router, catch-all 404) |
| `src/http/static.ts` | Create | `mountWebStatic`, `WEB_CSP` |
| `tests/http/api/helpers.ts` | Create | `makeApiTestApp(overrides)`: `express()` + json + `makeApiRouter` + `apiErrorHandler`, fakes from `tests/auth/fakes.ts` and `tests/review/fakes.ts` |
| `tests/http/api/errorHandler.test.ts` | Create | Each mapping row; malformed JSON → 400; non-AppError → 500 + logged; exact bodies |
| `tests/http/api/apiAuth.test.ts` | Create | No token → 401; dev header forwarded only with the flag; header dropped under `NODE_ENV=production` even with `devUserHeader:true` (spy authenticator receives no `devUser`) |
| `tests/http/api/permissions.test.ts` | Create | Opacity matrix (HU-07.5) |
| `tests/http/api/me.test.ts` | Create | `/me` per seeded role; platform_admin without memberships → `[]`; audit row |
| `tests/http/api/reviewQueue.test.ts` | Create | Routes: validation, 404/409 mapping, audit after success only |
| `tests/http/static.test.ts` | Create | Static + SPA + CSP behaviour (tmp dir from `os.tmpdir()`) |
| **G — Composition** | | |
| `src/mcp/context.ts` | Modify | `AppServices.reviewService: ReviewServiceLike` |
| `src/http/app.ts` | Modify | Options `devUserHeader`, `webStaticDir`, API rate limit; registration order above |
| `src/index.ts` | Modify | `authRepository` built before the authenticator; `new DevAuthenticator(authRepository)`; `PgReviewQueueRepository`; `ReviewService({…, confidenceThreshold: config.JUDGE_CONFIDENCE_THRESHOLD})`; `devUserHeader` only on the dev branch; `webStaticDir` only when `NODE_ENV !== 'production'`; API rate-limit values |
| `tests/auth/fakes.ts` | Modify | `makeStubAuthServices`: `reviewService` stub |
| `tests/http/security.test.ts` | Modify | `/api` limiter 429 + RateLimit headers; helmet headers on `/api` |
| `tests/http/app.routes.test.ts` | Create | With `webStaticDir`: `/health` JSON, `GET /mcp` 405, `GET /promote` not SPA, `/api/v1/unknown` JSON 404; without it: `GET /` 404 |
| `scripts/smoke.ts` | Modify | `GET /api/v1/me` with `X-Dev-User: tl@demo.local` → 200 with role `project_admin` |
| **H — Docs** | | |
| `README.md` | Modify | Config rows: `WEB_STATIC_DIR`, `RATE_LIMIT_API_WINDOW_MS/MAX` |
| `DEVELOPMENT.md` | Modify | `X-Dev-User` login and demo users; `closed_unmerged` curl; static dev serving; S3 + CloudFront production path |

## New Modules

None. `src/http/api` holds 7 files and `src/review` holds one. Neither has its own manifest or 10+ source files.

## Test Strategy

The runner is vitest with tests in `tests/**/*.test.ts`. DB-gated suites use the existing `*.integration.test.ts` skip-without-`DATABASE_URL` pattern. HTTP tests use supertest on `createApp`/`makeApiTestApp`. (The loaded `.claude/rules/tests.md` describes node:test/`test/*.js`, which does not match this repo; this design follows the actual codebase, as C1 did.)

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| HU-07.1 open item | unit (routes + service) + integration | Detail has content, fields, origin branch/PR, author, verdict, criterion, confidence, `threshold` = config, reason, `mandatoryReview`, `sanitizeFlags` categories, `related` and `target` with status/version/origin; `targetStale` true when the target moved; resolved item → 404; foreign item id (other project) → 404 | `reviewQueue.integration` asserts the real SQL |
| HU-07.2 approve | integration (`review.integration`) | Queued `add` → memory + revision 1, `approved_by` = TL, staging `promoted_at`, `review_decision='approved'`, `reviewed_by`, `reviewed_at`, **`judge_state` unchanged**, item leaves the queue; mandatory accepted `decision` applies; uncertain `amend` → revision +1; deprecate; dedup add → `deduped:true`, existing `approved_by` untouched | Uses the same apply SQL; refactor regression in `promotion.integration` |
| Approve + supersede related | integration | `markRelatedSuperseded:true` → new memory active, related `superseded`, `memory_relation(source='human')`; related already superseded / null / deprecate op → `relatedSuperseded:false`, nothing else changed | |
| Stale target rebase | integration + unit | Target moved r1→r2: approve without `targetRevision` → 409 `target_changed`, item still queued; with `targetRevision:2` → applied as revision 3, staging `target_revision=2`, audit `{rebasedFromRevision:1, rebasedToRevision:2}`; `targetRevision:1` when current is 2 → 409; target deprecated → 409 `target_inactive` | |
| Duplicate on approve | integration | amend whose content equals another memory → 409 `duplicate_content`, transaction rolled back, item queued | |
| HU-07.3 reject | unit + integration | Reason "too vague" → quarantine row `judge_reason='human_review: too vague'`, staging `review_decision='rejected'`, `review_reason`, `judge_state` unchanged; reason missing / 2 chars / 501 chars → 400 with no echo; reason containing an AWS key → 400, nothing stored; reason with an email → stored masked `[EMAIL]` | |
| Concurrency | integration | Two clients: approve and reject the same item in parallel (`Promise.all` on separate pool clients) → exactly one success, the other `not_found`/404, exactly one of {memory, quarantine} exists; repeat approve → 404 with no new access_log `update` row; `closed_unmerged` racing approve → approved row survives the DELETE | Real PG row locks |
| Counters / filters | integration | 3 uncertain + 2 mandatory + 4 reviewed in the last 7 days (+1 reviewed 8 days ago, +1 in another project, +1 in an abandoned session) → pending 5, uncertain 3, mandatory 2, resolvedLast7Days 4; `filter=uncertain` → 3; `type=decision` filter; `limit` → `truncated` | Spec scenario |
| HU-07.5 / opacity | unit (`permissions.test`) | contributor, viewer, other-project admin, platform_admin without membership, disabled user, malformed project uuid, random project uuid → byte-identical 404 bodies on all 4 routes; non-admin with invalid body → 404, not 400; no `accessLogEntries` on any denial | `InMemoryAuthRepository` |
| Gate 1 / dev login | unit | No token (bypass off) → 401 `{"error":"Unauthorized"}`; `X-Dev-User: tl@demo.local` → `/me` shows project_admin; `viewer@` → viewer; unknown email → 401; absent header → default dev user | Spec "Development login" |
| Dev header prod guard | unit | (1) config `AUTH_DEV_BYPASS=true` + production → exit(1) (existing `prodGuard.test`); (2) `NODE_ENV=production`, `createApp` with `devUserHeader:true` and a spy authenticator → spy gets no `devUser`, missing token → 401; (3) `new DevAuthenticator()` under production throws, and `authenticate` refuses; (4) Cognito authenticator fake ignores `opts.devUser` | Restore `process.env` in `afterEach` |
| `/me` | unit + integration | User fields; projects with role; archived project hidden; platform_admin without membership → `[]`; audit `me.read` with project null | |
| Error mapper | unit | Each row of the mapping table with exact bodies; malformed JSON on `/api` → 400; `/promote` errors still 500 (unchanged) | |
| HU-04.2 closed_unmerged | unit (`promote.test`) + integration | 3 items on `feature/x` → `{status:'abandoned', discarded:3}`, session `abandoned`, items gone, audit `delete`; repeat → `no_op`; promoted row kept; missing `pr_number` / with `merge_sha` → denied; ref `refs/pull/7/merge` with `head_ref ≠ source_branch` → denied; ref `refs/pull/8/merge` for `pr_number:7` → denied; `source_branch = main` → denied; no credential → denied; merged without `event` on a feature branch → denied as before; merged on main → unchanged outcome | `FakePromotionRepository` + DB-gated `abandonOpenSession` |
| OIDC claims | unit | `head_ref` present / empty / absent; dev verifier honours `devRef` | |
| Static | unit (`static.test`, `app.routes.test`) | `GET /` → index.html + CSP + no-cache; `GET /deep/route` → index.html + CSP; `GET /assets/app.js` → JS with **no** CSP; `GET /missing.png` → 404 (not index); `POST /x` → not fallback; `/api/v1/unknown` → JSON 404; `/health`, `/mcp` (405), `/promote` (GET → not SPA) unaffected; missing index.html → `mountWebStatic` throws | tmp dir via `fs.mkdtempSync(os.tmpdir())` |
| Rate limit | unit (`security.test`, `rateLimitGuard.test`) | `/api` over `apiMax` → 429 `{"error":"Too Many Requests"}` + `RateLimit-*`; API config defaults/invalid; production guard unchanged | Existing pattern |
| Review service | unit | Outcome mapping; embedding computed from the pre-read row and passed with `expectedContentHash`; embedder throw → null; deprecate → no embed; repo `conflict` → 409 code passthrough | |
| Promotion guards | integration | Promotion `quarantineItem` on a human-reviewed item → no quarantine row, warn logged; `recordDecision` on a reviewed row → no change; `applyAccepted` on a reviewed row → `already` | |
| Seed | integration | After `seed:dev`, the three users resolve by email, with memberships project_admin / contributor / viewer on project `…0010`; re-running the seed is idempotent | In `authRepository.integration` |
| Smoke | e2e (`pnpm smoke`) | `/api/v1/me` as `tl@demo.local` → project_admin; existing promote steps green | compose dev stubs |
