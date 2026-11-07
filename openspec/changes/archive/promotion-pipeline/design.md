# Design: Promotion Pipeline (local-testable vertical)

schema: design-v1
change: promotion-pipeline
status: DESIGN
date: 2026-07-30
depends_on: proposal.md, exploration.md (both authoritative)

## Technical Approach

Close the write-to-main loop **locally and testably** with the same injectable-seam +
config-guard pattern the codebase already uses for Cognito. A real `POST /promote` endpoint
is `curl`-able under the dev harness. Its chain is:

    POST /promote → OidcVerifier (dev stub) → authorizePromote (machine_credential)
                  → PromoteService.promote(sessionId) → per item:
                       sanitize (assertNoSecrets) → judge (deterministic stub)
                       → applyAccepted | quarantine | leave-uncertain → mark item
                  → finalize session terminal state

The two AWS-coupled pieces — the **real Bedrock judge** and the **real GitHub-OIDC/JWKS +
API Gateway** — land now only as fail-closed skeletons behind the same seams; their real
bodies are DEFERRED and drop in without touching orchestration. **No new runtime dependency
is added** in this change (the Bedrock SDK arrives out-of-band with the deferred real judge).

Everything is grounded in existing code:
- Write surface mirrors `src/db/stagingRepository.ts` (top-level SQL constants, `pg.Pool`,
  parameterized `$N`, raw-row → mapped-row, `AppError` on bad input).
- Seams mirror `src/auth/authenticator.ts` + `src/auth/devAuthenticator.ts` (interface +
  ctor injection + config-guarded dev stub selected at the composition root).
- Config guard mirrors `src/config/index.ts` (`z.enum(['true','false']).transform`, NOT
  `z.coerce.boolean`; `superRefine` forbids the stub/bypass in production).
- Endpoint mirrors `src/mcp/transport.ts` `makeMcpPostHandler` (one-line factory in
  `src/http/app.ts`, try/catch → `next(err)` into the terminal opaque error handler).
- Sanitize reuses `src/security/secretScan.ts` `assertNoSecrets` (fail-closed, category-only).
- Schema is fully ready: migration `0004_promotion_gaps.sql` closed every gap
  (`staging_item.promoted_at`/`promoted_memory_id`, `staging_status += partially_promoted`,
  `quarantine`). No new migration is required by this change.

## Architecture Decisions

### Decision 1: Per-item transaction granularity

**Choice**: One database transaction **per item**, opened inside the `PromotionRepository`
apply/quarantine methods via `pool.connect()` → `BEGIN` … `COMMIT`/`ROLLBACK`. The session
terminal-state `UPDATE` is a separate final statement after the loop (its own implicit txn).
The service loop is sequential (no `Promise.all`).

**Alternatives considered**: One all-or-nothing transaction wrapping the whole session.

**Rationale**: `partially_promoted` (added by migration 0004) is only reachable if items
commit independently — one poisoned/stale item must not roll back the accepted ones. Per-item
commit also gives **idempotent resume**: a crash mid-session leaves already-applied items
marked (`promoted_at` set) and a re-run skips them. Each apply txn locks the target
`staging_item` row `FOR UPDATE` and re-checks `promoted_at IS NULL` before writing, so two
concurrent `promote()` calls on the same session serialize per item (first-writer-wins). The
all-or-nothing alternative cannot express `partially_promoted` and forces re-doing accepted
work on any single failure.

### Decision 2: New `PromotionRepository` file (not extend `PgMemoryRepository`)

**Choice**: New `src/db/promotionRepository.ts` with `PromotionRepository` interface +
`PgPromotionRepository` class, mirroring `stagingRepository.ts`.

**Alternatives considered**: Add write methods to `PgMemoryRepository`.

**Rationale**: `memoryRepository` is deliberately **read-only** (recall / getMemoryByHandle /
getContextRecords) — a design invariant repeated across the map and exploration. Keeping the
write surface in its own module preserves that invariant, isolates the transactional/locking
code, and matches the established one-repository-per-concern layout (`authRepository`,
`memoryRepository`, `stagingRepository`).

### Decision 3: `/promote` authorization on the single RBAC lib via a new `authorizePromote` method

**Choice**: Add `authorizePromote(principal: PromotePrincipal, tenant: TenantContext):
Promise<ActorIdentity>` to the **existing `Authorizer` seam and `RdsAuthorizer` class**
(single RBAC lib). It does NOT call the human `app_user`/`project_membership` path. Add
`'promote'` to the `ToolName` union for audit typing only (it is NOT added to `WRITE_TOOLS`,
because promote never flows through `authorize()`).

**Exact check** (machine path, schema-faithful to `machine_credential` in 0001):
1. Resolve `repo` by GitHub slug → `(projectId, repoId)` (Decision 4).
2. `AuthRepository.findActiveMachineCredential(projectId, principalName)`:
   ```sql
   SELECT role FROM machine_credential
   WHERE project_id = $1
     AND principal_name = $2
     AND role IN ('service_agent','contributor','project_admin')
     AND revoked_at IS NULL
     AND expires_at > now()
   ```
   `$2` = `principal.repository` (the OIDC `repository` claim, e.g. `crombie-dev/lpms-cloud`).
   Null result → `AppError(PERMISSION_DENIED)` (opaque; no oracle).
3. Return `ActorIdentity { actorId: principal.repository, roles: [role] }`.

**Alternatives considered**: (a) route `tool='promote'` through the existing
`authorize()` — rejected: that method does the `app_user` + `project_membership` lookup, which
a CI/OIDC principal has no rows in, so it would always deny; (b) a separate `PromoteAuthorizer`
class — rejected: splits the RBAC lib (the map explicitly warns against split-brain RBAC).

**Rationale**: One RBAC class, one authz table family, but an honestly-different query for the
machine identity. `machine_credential` is tenanted by `project_id` (not `repo_id`); the
repo→project resolution in Decision 4 supplies that binding, so a token minted for repo A can
never authorize a promote into project B.

### Decision 4: Tenant resolution by GitHub slug (new `findRepoByGithubSlug`)

**Choice**: New `AuthRepository.findRepoByGithubSlug(ownerRepo: string):
Promise<RepoResolution | null>`. It **canonicalizes** the OIDC `repository` claim
(`owner/repo`) into the repo's natural unique key and reuses the proven equality lookup:
```sql
-- ownerRepo → 'https://github.com/' || ownerRepo || '.git'
SELECT id, project_id, default_branch FROM repo WHERE remote_url = $1
```

**Alternatives considered**: (a) reuse `findRepoByRemoteUrl` directly with `X-Git-Remote` —
rejected: the OIDC path carries a `repository` claim (`owner/repo`), not a git remote URL, and
must not trust a client header for tenant; (b) fuzzy match on `repo.slug` — rejected: `slug`
is not unique across orgs and could cross tenants.

**Rationale**: Reuses `repo.remote_url` (the `UNIQUE` natural key) so no ambiguity and **no
seed `repo` change**. The provider/host assumption (`https://github.com/…​.git`) is centralized
in one named method and clearly marked a pilot simplification; the deferred real
`GithubOidcAuthenticator` will carry a more robust claim→repo mapping. `RdsTenantResolver`
(header-based) is untouched — this is a distinct, named seam for the OIDC path.

### Decision 5: `BedrockJudge` = pure interface + fail-closed wrapper with a TODO body

**Choice**: `src/judge/judge.ts` declares the `Judge` interface. `bedrockJudge.ts` implements
`evaluate()` as a fail-closed wrapper around a private `invokeModel()` whose body is a
clearly-marked `// DEFERRED` `throw`. `evaluate()` catches **every** error → returns
`'uncertain'`. Selected only when `JUDGE_STUB=false`. **No `@aws-sdk/*` import is added.**

```ts
async evaluate(item: JudgeItem): Promise<Verdict> {
  try { return await this.invokeModel(item); }   // real path (deferred)
  catch (err) { logger.warn('BedrockJudge failed — failing closed to uncertain'); return 'uncertain'; }
}
private async invokeModel(_item: JudgeItem): Promise<Verdict> {
  // DEFERRED: Bedrock InvokeModel via VPC PrivateLink + IAM. Out-of-band `pnpm add`.
  throw new Error('BedrockJudge.invokeModel not implemented (deferred)');
}
```

**Alternatives considered**: a real `InvokeModel` call now — rejected: requires the Bedrock
SDK (new runtime dep) + VPC/IAM/model-access, none testable in the harness; a bare interface
with no class — rejected: the fail-closed contract (docs/04: LLM down → `uncertain`, NEVER
`accepted`) deserves a unit test *now*, before the real body exists.

**Rationale**: Proves and tests the mandated fail-closed behavior immediately; the real call
is a drop-in replacement of one private method with zero orchestration change.

### Decision 6: Stale target → quarantine(reason=`stale_target`)

**Choice**: At apply time, `amend`/`supersede`/`deprecate` do `SELECT … FOR UPDATE` on the
target `memory` row and assert `current_revision == item.target_revision AND status='active'`.
On mismatch (moved, missing, or non-active): **no memory write**, `ROLLBACK`, then the service
`quarantineItem(item, reason='stale_target')` and sets `judge_state='rejected'`. **No 3-way
merge.** A `UNIQUE(project_id, content_hash)` violation on `amend`/`supersede` is caught
(`23505`) and quarantined with reason `duplicate_content`.

**Alternatives considered**: mark `uncertain` and route to a human queue — rejected: no Web UI
in the pilot; `add`-only re-derivation is impossible without merge logic.

**Rationale**: Safe-by-default — never silently overwrites a moved record and never loses
content (the item is snapshotted in `quarantine`). Reconciliation (3-way merge / UI) is a
separate, explicitly-deferred concern.

### Decision 7: Uncertain items left un-applied → `partially_promoted`

**Choice**: `uncertain` items are persisted (`judge_state='uncertain'`), NOT applied and NOT
quarantined. If a session has any applied item and any uncertain/rejected item, its terminal
status is `partially_promoted`.

**Rationale**: Fail-closed judging routes ambiguity to a human queue that does not exist yet;
leaving the item in staging (un-applied, un-promoted) is the only safe pilot behavior and
matches `judge_states: uncertain → human queue` in the map.

### Decision 8: Config guards — exact new env + superRefine

**Choice**: Four new vars, all `z.enum(['true','false']).transform` or guarded strings, with
`superRefine` rules that make every stub/bypass impossible in production (mirrors the existing
`AUTH_DEV_BYPASS` guard). Secure defaults (`false`) so a bare prod env never enables a stub.

## Data Flow

    GitHub Action (deferred)                POST /promote
        │  OIDC JWT + body                      │
        ▼                                       ▼
    ┌──────────────────────── makePromoteHandler(services) ────────────────────────┐
    │ 1 zod-parse body {repo, source_branch, pr_number, merge_sha}                  │
    │ 2 oidcVerifier.verify(Authorization) → PromotePrincipal{repository, ref}      │
    │ 3 assert body.repo === principal.repository  (else PERMISSION_DENIED)         │
    │ 4 authRepository.findRepoByGithubSlug(principal.repository) → TenantContext   │
    │ 5 authorizer.authorizePromote(principal, tenant) → ActorIdentity              │
    │ 6 promotionRepo.findOpenSessionId(tenant, source_branch) → sessionId | null   │
    │ 7 promoteService.promote(sessionId, meta) ──────────┐                         │
    └─────────────────────────────────────────────────────┼─────────────────────────┘
                                                          ▼
      fetchPromotableItems(session)  ── per item ──▶  judge_state?
          pending → assertNoSecrets ─(throws)─▶ quarantine(secret_detected)
                    │ ok                                     ▲
                    ▼                                        │
              judge.evaluate ── accepted ─▶ applyAccepted ──┤ stale/dup ─▶ quarantine
                              ├ rejected  ─▶ quarantine ─────┘
                              └ uncertain ─▶ recordVerdict(uncertain)  (leave)
          accepted (prior)  ─▶ applyAccepted           rejected (prior) ─▶ skip
                    │
                    ▼
      memory + memory_revision (+ memory_relation for supersede)  ◀── per-item txn
                    │
                    ▼
      finalizeSession(promoted | rejected | partially_promoted)  ─▶ auditLogger.recordPromote

## PromotionRepository — interface + exact SQL

File: `src/db/promotionRepository.ts`. Constructor `constructor(private readonly pool: pg.Pool)`.
All SQL is a top-level `const` string, parameterized, tenant-scoped. `content_tsv` is
`GENERATED ALWAYS` and **never** appears in any column list. `fields` is `JSON.stringify(...)`
then cast `::jsonb` (mirrors `stagingRepository.insertStagingItem`).

```ts
export type Verdict = 'accepted' | 'rejected' | 'uncertain';

export interface PromotionItemRow {
  id: string; op: 'add'|'amend'|'supersede'|'deprecate'; type: MemoryType;
  title: string; summary: string; body: string; fields: Record<string, unknown>;
  content_hash: string; target_memory_id: string | null; target_revision: number | null;
  judge_state: 'pending'|'accepted'|'uncertain'|'rejected'; judge_reason: string | null;
  author_identity: string; promoted_at: Date | null; promoted_memory_id: string | null;
}

/** Tenant + promotion metadata threaded into every apply/quarantine call. */
export interface ApplyContext {
  projectId: string; repoId: string;
  originBranch: string; originPr: number | null;
}

export type ApplyResult =
  | { status: 'applied'; memoryId: string; deduped: boolean }
  | { status: 'stale' }
  | { status: 'duplicate' }
  | { status: 'already' };   // promoted_at already set (idempotent no-op)

export interface PromotionRepository {
  findOpenSessionId(tenant: TenantContext): Promise<string | null>;
  fetchPromotableItems(sessionId: string): Promise<PromotionItemRow[]>;
  recordVerdict(itemId: string, verdict: Verdict, reason: string | null): Promise<void>;
  applyAccepted(item: PromotionItemRow, ctx: ApplyContext): Promise<ApplyResult>;
  quarantineItem(item: PromotionItemRow, ctx: ApplyContext,
                 reason: string, redact: boolean): Promise<void>;
  finalizeSession(sessionId: string,
                  status: 'promoted'|'rejected'|'partially_promoted'): Promise<void>;
}
```

### findOpenSessionId — the open session for the branch
```sql
-- $1=project_id  $2=repo_id  $3=branch
SELECT id FROM staging_session
WHERE project_id = $1 AND repo_id = $2 AND branch = $3 AND status = 'open'
```

### fetchPromotableItems — candidates (not yet applied)
```sql
-- $1=session_id
SELECT id, op, type, title, summary, body, fields, content_hash,
       target_memory_id, target_revision, judge_state, judge_reason,
       author_identity, promoted_at, promoted_memory_id
FROM staging_item
WHERE session_id = $1 AND promoted_at IS NULL
ORDER BY created_at ASC
```

### recordVerdict — persist judge decision (re-runs reuse it)
```sql
-- $1=judge_state  $2=judge_reason  $3=item_id
UPDATE staging_item SET judge_state = $1, judge_reason = $2 WHERE id = $3
```

### applyAccepted — per-item transaction (`pool.connect()` → BEGIN … COMMIT)

Every branch starts by locking the item row and enforcing idempotency:
```sql
-- LOCK + idempotency guard (S0). $1=item_id
SELECT promoted_at FROM staging_item WHERE id = $1 FOR UPDATE;
-- if promoted_at IS NOT NULL → COMMIT, return { status:'already' }
```

**op = 'add'** (dedup-safe, revision only when newly inserted):
```sql
-- A1 INSERT authoritative memory. content_tsv OMITTED (GENERATED ALWAYS).
-- $1=project_id $2=repo_id $3=type $4=title $5=summary $6=body $7=fields(jsonb)
-- $8=author_identity $9=content_hash $10=origin_branch $11=origin_pr
INSERT INTO memory
  (project_id, repo_id, type, title, summary, body, fields,
   status, provenance, author_identity, content_hash, current_revision,
   origin_branch, origin_pr)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
        'active', 'pr_reviewed', $8, $9, 1, $10, $11)
ON CONFLICT (project_id, content_hash) DO NOTHING
RETURNING id;
-- if 0 rows (dedup): SELECT id FROM memory WHERE project_id=$1 AND content_hash=$9;
--   → deduped=true, SKIP A2 (existing memory already carries revision 1)

-- A2 INSERT revision (ONLY when A1 inserted a new row). content_tsv N/A here.
-- $1=memory_id $2=op $3=title $4=summary $5=body $6=fields $7=type
-- $8=content_hash $9=author_identity $10=promoted_from_item(item.id)
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, 1, 'add', $3, $4, $5, $6::jsonb, $7, $8, $9, $10);
```

**op = 'amend'** (concurrency-gated):
```sql
-- M1 lock + stale check. $1=target_memory_id
SELECT id, current_revision, status FROM memory WHERE id = $1 FOR UPDATE;
-- if 0 rows OR current_revision <> item.target_revision OR status <> 'active'
--   → ROLLBACK, return { status:'stale' }

-- M2 update content (content_tsv OMITTED; regenerates automatically).
-- $1=title $2=summary $3=body $4=fields $5=type $6=content_hash
-- $7=author_identity $8=origin_branch $9=origin_pr $10=target_memory_id
UPDATE memory
SET title=$1, summary=$2, body=$3, fields=$4::jsonb, type=$5,
    content_hash=$6, author_identity=$7, provenance='pr_reviewed',
    origin_branch=$8, origin_pr=$9,
    current_revision = current_revision + 1, updated_at = now()
WHERE id = $10;   -- wrap in try: 23505 unique_violation → ROLLBACK, { status:'duplicate' }

-- M3 revision. revision_no = (current_revision read in M1) + 1
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, $2, 'amend', $3, $4, $5, $6::jsonb, $7, $8, $9, $10);
```

**op = 'supersede'** (new memory + relation, dedup + relation-idempotent):
```sql
-- S1 lock + stale check on OLD target (same shape as M1).
-- S2 INSERT new memory (identical column list to A1; status 'active', rev 1)
--    ON CONFLICT (project_id, content_hash) DO NOTHING RETURNING id;
--    if 0 rows → SELECT existing id (deduped), SKIP S3.
-- S3 INSERT revision for the NEW memory (op='supersede', revision_no=1) [new rows only]
-- S4 mark OLD superseded. $1=target_memory_id
UPDATE memory SET status='superseded', updated_at=now() WHERE id = $1;
-- S5 typed edge new──supersedes──▶old. $1=new_id $2=old_id
INSERT INTO memory_relation (from_memory, to_memory, relation_type, source)
VALUES ($1, $2, 'supersedes', 'judge')
ON CONFLICT (from_memory, to_memory, relation_type) DO NOTHING;
```

**op = 'deprecate'** (status flip; revision snapshots the target's CURRENT content):
```sql
-- D1 lock + stale check; also SELECT title, summary, body, fields, type, content_hash
--    of the target for the revision snapshot. $1=target_memory_id
SELECT id, current_revision, status, title, summary, body, fields, type, content_hash
FROM memory WHERE id = $1 FOR UPDATE;
-- stale → ROLLBACK { status:'stale' }

-- D2 flip status, bump revision.
UPDATE memory SET status='deprecated', current_revision = current_revision + 1,
                  updated_at = now()
WHERE id = $1;

-- D3 revision uses the TARGET's snapshotted columns (deprecate adds no new content).
INSERT INTO memory_revision
  (memory_id, revision_no, op, title, summary, body, fields, type,
   content_hash, author_identity, promoted_from_item)
VALUES ($1, $2 /*current_revision+1*/, 'deprecate', /*snapshot cols*/ ..., item.author_identity, item.id);
```

**Common final statement for every applied op** (first-writer-wins):
```sql
-- $1=promoted_memory_id  $2=item_id
UPDATE staging_item
SET promoted_at = now(), promoted_memory_id = $1, judge_state = 'accepted'
WHERE id = $2 AND promoted_at IS NULL;   -- 0 rows ⇒ raced → ROLLBACK, { status:'already' }
-- then COMMIT.  Return { status:'applied', memoryId, deduped }.
```

### quarantineItem — snapshot + mark rejected (one txn)
`redact=true` only on the `secret_detected` path (content that failed `assertNoSecrets`);
title/summary/body are replaced with `'[REDACTED: secret detected]'` (within budgets) and
`reason` stays **category-only** (never matched text). All other reasons store verbatim
content (it already passed sanitize).
```sql
-- Q1 snapshot (self-contained; NO FK to staging → sweep-safe).
-- $1=project_id $2=repo_id $3=origin_session_id $4=origin_item_id $5=op $6=type
-- $7=title $8=summary $9=body $10=fields $11=content_hash $12=judge_reason $13=author_identity
INSERT INTO quarantine
  (project_id, repo_id, origin_session_id, origin_item_id, op, type,
   title, summary, body, fields, content_hash, judge_reason, author_identity)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13);

-- Q2 mark the staging item terminal (so re-runs skip it; promoted_at stays NULL).
-- $1=judge_reason $2=item_id
UPDATE staging_item SET judge_state='rejected', judge_reason=$1 WHERE id=$2;
```

### finalizeSession — terminal state
```sql
-- $1=status ('promoted'|'rejected'|'partially_promoted')  $2=session_id
UPDATE staging_session
SET status = $1::staging_status, promoted_at = now()
WHERE id = $2 AND status = 'open'
```

## Judge seam

File `src/judge/judge.ts`:
```ts
export type Verdict = 'accepted' | 'rejected' | 'uncertain';
export interface JudgeItem {
  op: 'add'|'amend'|'supersede'|'deprecate'; type: MemoryType;
  title: string; summary: string; body: string; fields: Record<string, unknown>;
}
export interface Judge { evaluate(item: JudgeItem): Promise<Verdict>; }
```
- `src/judge/deterministicJudge.ts` — `constructor(private verdict: Verdict)`; `evaluate`
  returns the configured `verdict` unconditionally. **DEV/TEST ONLY**, selected when
  `JUDGE_STUB=true`.
- `src/judge/bedrockJudge.ts` — Decision 5: fail-closed wrapper; `catch → 'uncertain'`;
  private `invokeModel` is a marked `// DEFERRED` throw. No `@aws-sdk/*` import.

## OIDC seam for `/promote`

File `src/auth/oidcAuthenticator.ts`:
```ts
export interface PromotePrincipal { repository: string; ref: string; }  // e.g. 'org/repo', 'refs/heads/main'
export interface OidcVerifier { verify(authorization: string | undefined): Promise<PromotePrincipal>; }

/** DEFERRED real impl — fail-closed until GitHub JWKS verification lands. */
export class GithubOidcAuthenticator implements OidcVerifier {
  constructor(private readonly audience: string) {}
  async verify(_authorization: string | undefined): Promise<PromotePrincipal> {
    // DEFERRED: token.actions.githubusercontent.com JWKS + aud/iss/repository claim checks.
    throw new AppError(ErrorCode.PERMISSION_DENIED);   // fail-closed
  }
}
```
File `src/auth/devOidcAuthenticator.ts` (mirrors `devAuthenticator.ts`, loud DEV-ONLY banner):
```ts
export const DEV_PROMOTE_PRINCIPAL: PromotePrincipal = {
  repository: 'crombie-dev/lpms-cloud', // == seed repo remote_url canonical + machine_credential.principal_name
  ref: 'refs/heads/main',
};
export class DevOidcAuthenticator implements OidcVerifier {
  async verify(_authorization: string | undefined): Promise<PromotePrincipal> {
    return DEV_PROMOTE_PRINCIPAL;   // no token verification — DEV ONLY
  }
}
```
Authz + tenant seam: `authRepository.findRepoByGithubSlug(principal.repository)` (Decision 4)
→ `authorizer.authorizePromote(principal, tenant)` (Decision 3). Single RBAC lib; machine path.

## PromoteService.promote — orchestration

File `src/promote/promoteService.ts`.
```ts
export interface PromoteMeta {
  tenant: TenantContext; actor: ActorIdentity;
  originBranch: string; originPr: number | null; mergeSha: string | null;
}
export interface PromoteOutcome {
  status: 'promoted'|'rejected'|'partially_promoted'|'no_op';
  applied: number; deduped: number; quarantined: number; uncertain: number;
}
export class PromoteService {
  constructor(private readonly deps: {
    promotionRepository: PromotionRepository; judge: Judge;
    auditLogger: AuditLogger;
  }) {}
  async promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome> { /* below */ }
}
```

**Algorithm** (sequential; fail-closed; idempotent):
1. `items = fetchPromotableItems(sessionId)` (already excludes `promoted_at` set).
   If `items.length === 0` → return `{ status:'no_op', 0,0,0,0 }` (nothing to do — idempotent
   re-run after a completed promote).
2. `ctx: ApplyContext = { projectId, repoId, originBranch, originPr }` from `meta`.
   Counters `applied=deduped=quarantined=uncertain=0`.
3. For each `item` (in order):
   a. If `item.judge_state === 'rejected'` → already quarantined on a prior run → **skip**.
   b. **Determine verdict** (persisted verdict wins — never re-judge):
      - if `judge_state` is `'accepted'` or `'uncertain'` → reuse it.
      - if `'pending'`:
        - **Sanitize**: `try { assertNoSecrets(item.title, item.summary, item.body) }`
          `catch` → `quarantineItem(item, ctx, 'secret_detected', redact=true)`;
          `quarantined++`; **continue**.
        - `verdict = await judge.evaluate({op,type,title,summary,body,fields})`
          (BedrockJudge is fail-closed → `uncertain` on any error; the service NEVER maps a
          caught error to `accepted`).
        - `recordVerdict(item.id, verdict, verdict==='rejected' ? 'judge_rejected' : null)`.
   c. **Route on verdict**:
      - `accepted` → `r = applyAccepted(item, ctx)`:
        - `applied` → `applied++` (+ `deduped++` if `r.deduped`).
        - `stale`   → `quarantineItem(item, ctx, 'stale_target', false)`; `quarantined++`.
        - `duplicate` → `quarantineItem(item, ctx, 'duplicate_content', false)`; `quarantined++`.
        - `already` → treat as applied (idempotent); `applied++`.
      - `rejected` → `quarantineItem(item, ctx, item.judge_reason ?? 'judge_rejected', false)`;
        `quarantined++`.
      - `uncertain` → leave un-applied (verdict already persisted); `uncertain++`.
4. **Terminal status**:
   - `total = items.length`; let `nonSkipped` = items not short-circuited at 3a.
   - if `applied === total` → `'promoted'`
   - else if `applied === 0 && uncertain === 0` → `'rejected'`
   - else → `'partially_promoted'`.
   `finalizeSession(sessionId, terminalStatus)`.
5. `auditLogger.recordPromote({tenant, actor}, { sessionId, applied, quarantined, uncertain,
   prNumber: meta.originPr, mergeSha: meta.mergeSha })` (actorKind `'ci'`, action `'promote'`).
6. Return `{ status: terminalStatus, applied, deduped, quarantined, uncertain }`.

**Idempotency**: step 1's `promoted_at IS NULL` filter + `applyAccepted`'s `FOR UPDATE` +
`promoted_at IS NULL` guard mean a re-run applies nothing already applied and never
double-writes memory/revision; rejected items are skipped at 3a so no duplicate quarantine.

## POST /promote — handler + wiring

New `src/http/promote.ts`, factory `makePromoteHandler(services)` (mirrors
`makeMcpPostHandler`), wired in `src/http/app.ts` **before** the terminal error handler:
```ts
app.post('/promote', makePromoteHandler(services));
```
Request body (zod-validated; reject extras):
```ts
const PromoteBody = z.object({
  repo:          z.string().min(1),          // 'owner/repo' — MUST equal token claim
  source_branch: z.string().min(1),
  pr_number:     z.number().int().positive().optional(),
  merge_sha:     z.string().min(1).optional(),
}).strict();
```
Handler chain (each failure → `AppError(PERMISSION_DENIED)`; on throw `next(err)` → the
existing terminal handler returns the generic opaque 500 — no tenant/resource/stack leakage):
1. Parse+validate body (bad body → `PERMISSION_DENIED`, not a schema echo).
2. `principal = await services.oidcVerifier.verify(req.headers.authorization)`.
3. If `body.repo !== principal.repository` → `PERMISSION_DENIED` (token claim is authoritative).
4. `tenant = await services.authRepository.findRepoByGithubSlug(principal.repository)`
   (null → `PERMISSION_DENIED`).
5. `actor = await services.authorizer.authorizePromote(principal, tenant)`.
6. `sessionId = await services.promotionRepository.findOpenSessionId({...tenant,
   branch: body.source_branch})`; null → `200 { status:'no_op' }`.
7. `outcome = await services.promoteService.promote(sessionId, { tenant, actor,
   originBranch: body.source_branch, originPr: body.pr_number ?? null,
   mergeSha: body.merge_sha ?? null })`.
8. `res.status(200).json(outcome)`.

Wrap 2–8 in `try/catch`: `if (!res.headersSent) next(err)` (identical opacity model to
`makeMcpPostHandler`).

## config.ts — new guarded env + superRefine

Add to the object (all secure-default `false`; `.transform` NOT `z.coerce.boolean`):
```ts
JUDGE_STUB: z.enum(['true','false']).default('false').transform(v => v === 'true'),
JUDGE_STUB_VERDICT: z.enum(['accepted','rejected','uncertain']).default('accepted'),
BEDROCK_MODEL_ID: z.string().min(1).optional(),
PROMOTE_OIDC_DEV_BYPASS: z.enum(['true','false']).default('false').transform(v => v === 'true'),
GITHUB_OIDC_AUDIENCE: z.string().min(1).optional(),
```
Add to `superRefine` (LOAD-BEARING prod guards, mirroring the `AUTH_DEV_BYPASS` block):
```ts
if (cfg.JUDGE_STUB && cfg.NODE_ENV === 'production')
  addIssue('JUDGE_STUB', 'JUDGE_STUB=true is forbidden when NODE_ENV=production.');
if (cfg.PROMOTE_OIDC_DEV_BYPASS && cfg.NODE_ENV === 'production')
  addIssue('PROMOTE_OIDC_DEV_BYPASS', 'forbidden when NODE_ENV=production.');
if (!cfg.JUDGE_STUB && !cfg.BEDROCK_MODEL_ID)
  addIssue('BEDROCK_MODEL_ID', 'required when JUDGE_STUB is not true.');
if (!cfg.PROMOTE_OIDC_DEV_BYPASS && !cfg.GITHUB_OIDC_AUDIENCE)
  addIssue('GITHUB_OIDC_AUDIENCE', 'required when PROMOTE_OIDC_DEV_BYPASS is not true.');
```

## context.ts + index.ts — service-bag widening

`src/mcp/context.ts`:
- `ToolName` union: add `'promote'` (audit typing only; NOT added to `WRITE_TOOLS`).
- `Authorizer` interface: add
  `authorizePromote(principal: PromotePrincipal, tenant: TenantContext): Promise<ActorIdentity>;`
- `AuditLogger` interface: add
  `recordPromote(ctx: RequestContext, p: { sessionId: string; applied: number; quarantined: number; uncertain: number; prNumber: number | null; mergeSha: string | null }): Promise<void>;`
- `AppServices` gains: `promotionRepository: PromotionRepository`, `judge: Judge`,
  `oidcVerifier: OidcVerifier`, `authRepository: AuthRepository`,
  `promoteService: PromoteService`.
  (`judge` and `promotionRepository` are also captured inside `promoteService`; kept on the bag
  so tests can assert wiring.)

`src/index.ts` composition-root additions (after the existing seam construction):
```ts
const promotionRepository = new PgPromotionRepository(pool);
const judge = config.JUDGE_STUB && config.NODE_ENV !== 'production'
  ? (logWarnBanner('JUDGE_STUB ACTIVE — deterministic verdict'), new DeterministicJudge(config.JUDGE_STUB_VERDICT))
  : new BedrockJudge(config.BEDROCK_MODEL_ID!);          // superRefine guarantees presence
const oidcVerifier = config.PROMOTE_OIDC_DEV_BYPASS && config.NODE_ENV !== 'production'
  ? (logWarnBanner('PROMOTE_OIDC_DEV_BYPASS ACTIVE — OIDC stubbed'), new DevOidcAuthenticator())
  : new GithubOidcAuthenticator(config.GITHUB_OIDC_AUDIENCE!);
const promoteService = new PromoteService({ promotionRepository, judge, auditLogger });
```
Add `promotionRepository, judge, oidcVerifier, authRepository, promoteService` to the
`services: AppServices` object literal. Defense-in-depth `NODE_ENV !== 'production'` second
check on both stubs (mirrors the existing `DevAuthenticator` selection).

`RdsAuthorizer` gains `authorizePromote` (Decision 3); `RdsAuditLogger` gains `recordPromote`
(`actorKind:'ci'`, `action:'promote'`, `detail:{ sessionId, applied, quarantined, uncertain,
prNumber, mergeSha, repoId }`); `PgAuthRepository` gains `findRepoByGithubSlug` +
`findActiveMachineCredential`.

## seed.dev.sql — additions

Append (idempotent, fixed UUIDs/ULID; ON CONFLICT DO NOTHING):
1. **machine_credential** for the demo repo/project (enables `authorizePromote`):
   ```sql
   INSERT INTO machine_credential
     (id, project_id, principal_name, token_hash, role, created_by, expires_at)
   VALUES ('00000000-0000-0000-0000-000000000050',
           '00000000-0000-0000-0000-000000000010',
           'crombie-dev/lpms-cloud',            -- == DEV_PROMOTE_PRINCIPAL.repository
           'dev-oidc-not-a-real-secret', 'service_agent',
           '00000000-0000-0000-0000-000000000001', now() + interval '3650 days')
   ON CONFLICT DO NOTHING;
   ```
   (Existing `repo` row's `remote_url` `https://github.com/crombie-dev/lpms-cloud.git` already
   matches `findRepoByGithubSlug('crombie-dev/lpms-cloud')` — no repo change needed.)
2. **open staging_session** on `main` (promote target):
   ```sql
   INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, expires_at)
   VALUES ('01JDEMOPROMOTESESSION000001',
           '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020',
           'main','open','dev-local-user', now() + interval '7 days')
   ON CONFLICT DO NOTHING;
   ```
3. **one `pending` `add` staging_item** (secret-free; unique content_hash not colliding with
   any `seed-*` memory hash) so `curl /promote` runs judge → applies → new `memory` row:
   ```sql
   INSERT INTO staging_item
     (id, session_id, op, type, title, summary, body, content_hash, judge_state, author_identity)
   VALUES ('00000000-0000-0000-0000-000000000060','01JDEMOPROMOTESESSION000001',
           'add','pattern',
           'Promotion pipeline applies staged adds to memory',
           'A pending add promoted via /promote becomes an authoritative memory row.',
           'Demonstrates the local promotion vertical end to end: judge (stub) accepts, applyAccepted inserts memory + revision, session goes promoted.',
           'stage-add-demo-0001','pending','dev-local-user')
   ON CONFLICT DO NOTHING;
   ```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/db/promotionRepository.ts` | Create | `PromotionRepository` + `PgPromotionRepository`: 4-op apply (FOR UPDATE, stale check, dedup, content_tsv omitted), quarantine, finalizeSession, findOpenSessionId, per-item txns |
| `src/judge/judge.ts` | Create | `Judge` interface + `Verdict`/`JudgeItem` types |
| `src/judge/deterministicJudge.ts` | Create | Config-verdict stub (DEV/TEST) |
| `src/judge/bedrockJudge.ts` | Create | Fail-closed skeleton (catch→uncertain; DEFERRED invoke; no SDK dep) |
| `src/auth/oidcAuthenticator.ts` | Create | `OidcVerifier` + `PromotePrincipal` + `GithubOidcAuthenticator` fail-closed skeleton |
| `src/auth/devOidcAuthenticator.ts` | Create | `DevOidcAuthenticator` stub + `DEV_PROMOTE_PRINCIPAL` |
| `src/promote/promoteService.ts` | Create | Orchestration state machine (sanitize→judge→apply/quarantine→finalize) |
| `src/http/promote.ts` | Create | `makePromoteHandler` factory + zod body + auth chain + opacity |
| `src/http/app.ts` | Modify | Wire `app.post('/promote', makePromoteHandler(services))` before terminal handler |
| `src/config/index.ts` | Modify | 5 new env vars + 4 superRefine guards |
| `src/mcp/context.ts` | Modify | `ToolName+='promote'`; `Authorizer.authorizePromote`; `AuditLogger.recordPromote`; `AppServices` new fields |
| `src/auth/authorizer.ts` | Modify | `RdsAuthorizer.authorizePromote` (machine_credential check) |
| `src/auth/auditLogger.ts` | Modify | `RdsAuditLogger.recordPromote` (ci/promote) |
| `src/db/authRepository.ts` | Modify | `findRepoByGithubSlug` + `findActiveMachineCredential` |
| `src/index.ts` | Modify | Construct judge/oidcVerifier/promotionRepository/promoteService (config-guarded) + widen services bag |
| `migrations/seed.dev.sql` | Modify | machine_credential + open session + pending add item |
| `tests/**` | Create | Unit + DB-gated integration + supertest (below) |

No new migration file. No new runtime dependency (`package.json`/lockfile untouched).

## Test Plan (Vitest; `pnpm build && pnpm test -- --run && pnpm lint`)

**Unit (no DB; fakes mirror `tests/auth/fakes.ts`):**
- `DeterministicJudge` returns each configured verdict.
- `BedrockJudge` fail-closed: `invokeModel` throwing → `evaluate` resolves `'uncertain'`
  (asserts the mandated contract; the load-bearing security test).
- `PromoteService` state machine over a fake `PromotionRepository` + fake `Judge`:
  - accepted→applied; rejected→quarantine; uncertain→left; stale→quarantine(stale_target);
    duplicate→quarantine(duplicate_content).
  - sanitize reuse: an item containing an `AKIA…`/PEM string → `quarantineItem(secret_detected,
    redact=true)`, judge NEVER consulted.
  - terminal status: all-applied→`promoted`; all-rejected→`rejected`; mixed→`partially_promoted`;
    empty→`no_op`.
  - fail-closed: judge returns `uncertain` → item not applied.
- `config`: `JUDGE_STUB=true`+`NODE_ENV=production` fails load; `PROMOTE_OIDC_DEV_BYPASS=true`+
  prod fails; `JUDGE_STUB=false` without `BEDROCK_MODEL_ID` fails; bypass=false without
  `GITHUB_OIDC_AUDIENCE` fails; `.transform` treats `'false'` as `false`.
- `DevOidcAuthenticator` returns `DEV_PROMOTE_PRINCIPAL`; `GithubOidcAuthenticator.verify`
  throws `PERMISSION_DENIED` (fail-closed skeleton).

**DB-gated integration (real Postgres; skipped when `DATABASE_URL` unset, per existing
convention):**
- Each op applied end-to-end against migrated schema:
  - `add` → memory(status active, current_revision 1, provenance `pr_reviewed`) + revision(1,`add`);
    `content_tsv` populated (asserts it was never in the column list yet generated).
  - `amend` → memory content+`current_revision++`, revision(`amend`).
  - `supersede` → new memory + old `status='superseded'` + `memory_relation(supersedes, judge)`.
  - `deprecate` → target `status='deprecated'`, `current_revision++`, revision(`deprecate`).
- `add` dedup: second apply of identical `content_hash` → no new memory, no new revision,
  `promoted_memory_id` = existing id.
- Concurrency conflict: set `target_revision` stale vs DB → `applyAccepted` returns `stale`,
  no memory write, item quarantined `stale_target`.
- `supersede` re-run: `memory_relation` `ON CONFLICT DO NOTHING` → no duplicate edge.
- Quarantine: rejected + secret_detected(redacted) rows land in `quarantine`, item
  `judge_state='rejected'`.
- Terminal state transitions on `staging_session` (`promoted`/`rejected`/`partially_promoted`).
- **Idempotent re-run**: call `promote(sessionId, …)` twice → second run applies 0, writes no
  new memory/revision/quarantine rows, session status unchanged.
- `findOpenSessionId` / `findRepoByGithubSlug` / `findActiveMachineCredential` return-shape +
  null cases.

**HTTP (supertest against `createApp`, dev stubs active):**
- `POST /promote` with `PROMOTE_OIDC_DEV_BYPASS=true` + `JUDGE_STUB=true(accepted)` +
  seeded session → `200 { status:'promoted', applied:1 }`; the seeded pending item becomes a
  `memory` row.
- `body.repo !== token repository` → opaque denial (no body echo, no tenant/resource detail).
- No open session for branch → `200 { status:'no_op' }`.
- Unknown repo slug → opaque denial.
- Terminal error handler returns generic 500 with no `err.message`/stack on an injected fault.

## DEFERRED — explicitly NOT built (scope fence)

- **Real `BedrockJudge.invokeModel`** (Bedrock InvokeModel via VPC PrivateLink + IAM +
  model-access grant) and the out-of-band `pnpm add @aws-sdk/*`. Skeleton + fail-closed only.
- **Real GitHub-OIDC JWKS verification** (`token.actions.githubusercontent.com`, `aud`/`iss`/
  `repository` claim checks) + **API Gateway IAM authorizer** config. Stub + skeleton only.
- **GitHub Action YAML** (PR-merge trigger, request-body construction, OIDC token mint).
- **`machine_credential` provisioning** for the real Actions role (a dev credential is seeded).
- **Quarantine sweep / retention job** and the 1-vs-2-month retention decision (`expires_at`
  left NULL by this change).
- **3-way merge** reconciliation for stale targets (they quarantine).
- **Web UI human-review queue** for `uncertain` items (they remain staged → `partially_promoted`).
- **New migration** — none; 0004 already closed all schema gaps.
