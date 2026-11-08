# Design: Quarantine management — span redaction, restore, retention and jobs (C3, HU-10)

## Technical Approach

C3 builds on C1 (sanitize → judge → route → apply, already in `src/`) and on C2 (REST chain, `insertQuarantineSnapshot` transaction core, `recordApi`, error mapper). **C2 must have landed before this change is implemented.** No new runtime dependency is needed. Everything uses zod, `node:crypto`, pg and Express, which are already installed.

The change has four parts:

1. **Schema (0008)**. The quarantine row gets a classification (`criterion`, `reason_code`), the related memory, the restore label (`restored_*`) and a real `expires_at`. It also gets **`target_memory_id`/`target_revision`**: without them, a non-`add` item cannot be rebuilt on restore (see the scope note below).
2. **Span redaction**. Today a secret blanks the whole field. Now `scanForSecretsWithRanges` finds the exact spans, which are replaced with `[REDACTADO]`. PII masking runs next. A final check confirms the result is secret-free, and **any doubt falls back to whole-field redaction**. Redaction runs in C1's sanitize S2 (service side), because it must happen *before* PII masking. The repository re-checks before it writes (defence in depth).
3. **Quarantine API + restore**. Three routes run on the C2 chain, with a new *project member* gate: reads are allowed for the project admin or the author, and restore for the admin only. Restore claims the row atomically, creates a one-item session `restore/<id>`, and runs the **same** per-item pipeline through a new exported `PromoteService.promoteItem`.
4. **Jobs**. A shared `/internal/jobs` router (the contract with C4), the `quarantine-purge` job, a tsx script, and `QUARANTINE_RETENTION_DAYS` / `JOBS_TOKEN` config.

**Scope note for the orchestrator (needs a spec delta).** The proposal's 0008 column list does not include the target. A non-`add` row cannot be restored without it, because `ck_item_optarget` (0003:80) requires `target_memory_id` on every non-add. This design adds two nullable columns, `target_memory_id` (FK SET NULL) and `target_revision`, and backfills them through `origin_item_id`. A non-add row whose target cannot be rebuilt (legacy row whose item was swept, or a deleted target) returns 404 on restore, by the same reasoning as D3. The change is additive and reversible.

**Test-rules note.** The loaded `.claude/rules/tests.md` describes node:test with `test/*.js`. This repo uses vitest with `tests/**/*.test.ts` (project map). This design follows the codebase, as C1 and C2 did.

## Architecture Decisions

### Decision: Migration 0008 — two enums, additive nullable columns, idempotent backfill

**Choice**: `migrations/0008_quarantine_management.sql`. Enums are created in `DO`-blocks that catch `duplicate_object`. Columns use `ADD COLUMN IF NOT EXISTS`, with each FK inline on its guarded clause (0004/0007 precedent). The backfill only touches rows `WHERE criterion IS NULL`, so re-applying the file is a no-op and a legacy row inserted later is still classified. New columns stay **nullable**, so the pre-C3 code, which does not write them, keeps working after a rollback.

```sql
-- Migration 0008: quarantine management (C3 / HU-10).
-- Additive and idempotent: every statement is guarded; the backfill only touches
-- unclassified rows. Columns stay nullable so pre-C3 code keeps inserting.

DO $$ BEGIN
  CREATE TYPE quarantine_criterion AS ENUM ('pipeline','judge','human_review');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quarantine_reason_code AS ENUM
    ('secret_detected','embedded_instructions','duplicate_content',
     'judge_rejected','human_rejected','sanitize_failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS criterion   quarantine_criterion;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS reason_code quarantine_reason_code;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS related_memory_id uuid
  REFERENCES memory(id) ON DELETE SET NULL;
-- Needed to rebuild a non-add item on restore (ck_item_optarget).
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS target_memory_id uuid
  REFERENCES memory(id) ON DELETE SET NULL;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS target_revision int;
-- Restore label (judge measurement: restored_at IS NOT NULL = false-positive candidate).
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_by uuid
  REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_at timestamptz;
ALTER TABLE quarantine ADD COLUMN IF NOT EXISTS restored_item_id uuid;   -- no FK: staging is swept

-- Backfill classification + related/target from the origin item when it still exists.
-- Fallback when the item was swept: duplicate_content → pipeline (no criterion to read).
UPDATE quarantine q
SET criterion         = m.criterion,
    reason_code       = m.reason_code,
    related_memory_id = COALESCE(q.related_memory_id, m.related_memory_id),
    target_memory_id  = COALESCE(q.target_memory_id,  m.target_memory_id),
    target_revision   = COALESCE(q.target_revision,   m.target_revision)
FROM (
  SELECT q2.id,
    (CASE
       WHEN starts_with(q2.judge_reason, 'human_review:')                           THEN 'human_review'
       WHEN q2.judge_reason IN ('secret_detected','embedded_instructions','sanitize_failed') THEN 'pipeline'
       WHEN q2.judge_reason = 'duplicate_content' AND si.judge_criterion = 'duplication' THEN 'judge'
       WHEN q2.judge_reason = 'duplicate_content'                                    THEN 'pipeline'
       ELSE 'judge'                       -- security_second_layer, specificity, legacy judge_rejected, other
     END)::quarantine_criterion AS criterion,
    (CASE
       WHEN starts_with(q2.judge_reason, 'human_review:')   THEN 'human_rejected'
       WHEN q2.judge_reason = 'secret_detected'             THEN 'secret_detected'
       WHEN q2.judge_reason = 'security_second_layer'       THEN 'secret_detected'
       WHEN q2.judge_reason = 'embedded_instructions'       THEN 'embedded_instructions'
       WHEN q2.judge_reason = 'sanitize_failed'             THEN 'sanitize_failed'
       WHEN q2.judge_reason = 'duplicate_content'           THEN 'duplicate_content'
       ELSE 'judge_rejected'
     END)::quarantine_reason_code AS reason_code,
    si.related_memory_id, si.target_memory_id, si.target_revision
  FROM quarantine q2
  LEFT JOIN staging_item si ON si.id = q2.origin_item_id
  WHERE q2.criterion IS NULL
) m
WHERE q.id = m.id;

-- Retention backfill (proposal: quarantined_at + 60 days; rows older than that
-- become purgeable on the first job run — documented in DEVELOPMENT.md).
UPDATE quarantine SET expires_at = quarantined_at + interval '60 days' WHERE expires_at IS NULL;

-- List query: project-scoped, newest first, active (non-restored) rows only.
CREATE INDEX IF NOT EXISTS ix_quarantine_list
  ON quarantine (project_id, quarantined_at DESC, id DESC) WHERE restored_at IS NULL;
```

`starts_with` is used instead of `LIKE 'human_review:%'`, because `_` is a LIKE wildcard. `ix_quarantine_project` and `ix_quarantine_expires` (0004) are kept. The purge uses the second one.

**Alternatives considered**:
- (a) `text` + CHECK, as C1 did for `judge_criterion`. Rejected: the proposal and task fix enums, and the value sets are closed by the TFG reason table. The cost is that `ADD VALUE` cannot be undone, which is acceptable for a closed set.
- (b) `NOT NULL` after the backfill. Rejected: a rolled-back binary would then fail every quarantine insert.
- (c) Skip the target columns and allow restore for `add` only. Rejected: it silently drops restore for amend, supersede and deprecate. Those are mandatory-review ops, so they are the ones a tech lead most needs to restore.

**Reversible**: Partial. Manual down: `DROP INDEX ix_quarantine_list; ALTER TABLE quarantine DROP COLUMN criterion, reason_code, related_memory_id, target_memory_id, target_revision, restored_by, restored_at, restored_item_id; DROP TYPE quarantine_reason_code, quarantine_criterion;`. The `expires_at` backfill is not undone, which is harmless because the old code ignores the column.

### Decision: One pure classifier is the single source of the mapping (insert and backfill)

**Choice**: `src/quarantine/reason.ts` (pure, no I/O):

```ts
export const QUARANTINE_CRITERIA = ['pipeline', 'judge', 'human_review'] as const;
export const QUARANTINE_REASON_CODES = ['secret_detected', 'embedded_instructions', 'duplicate_content',
  'judge_rejected', 'human_rejected', 'sanitize_failed'] as const;
export type QuarantineCriterion = (typeof QUARANTINE_CRITERIA)[number];
export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];
/** How the snapshot content is stored. */
export type QuarantineRedaction = 'none' | 'spans' | 'whole';
export const HUMAN_REVIEW_PREFIX = 'human_review: ';

export function classifyQuarantine(reason: string, decisionCriterion: DecisionCriterion | null):
  { criterion: QuarantineCriterion; reasonCode: QuarantineReasonCode };
```

It implements the same table as the backfill's `CASE`, row for row:

| `judge_reason` written today | criterion | reason_code |
|---|---|---|
| `secret_detected`, `embedded_instructions`, `sanitize_failed` (S1–S3) | pipeline | same code |
| `duplicate_content` with decision criterion `duplication` (R3) | judge | duplicate_content |
| `duplicate_content` otherwise (S4 `hash_conflict`, A3 memory-hash collision) | pipeline | duplicate_content |
| `security_second_layer` (R2) | judge | secret_detected |
| `specificity` (R4), legacy `judge_rejected`, anything else | judge | judge_rejected |
| starts with `human_review:` (C2 reject) | human_review | human_rejected |

The fine-grained judge reason stays in `judge_reason` (D1). A unit test (`tests/quarantine/reason.test.ts`) and the migration test run the **same fixture table** against `classifyQuarantine` and against the SQL backfill, so the two cannot drift.

**Rationale**: Callers keep passing only the reason they pass today, so C1 and C2 call sites are unchanged. The mapping lives in one place in code, and the SQL mirror is tested against it.

**Reversible**: Yes.

### Decision: Span redaction algorithm — per-category ranges, merge, right-to-left replace, then a fail-closed verify

**Choice**:

**`src/security/secretScan.ts`**. The pattern table gains a global `range` regex per category, used only to find spans. `scanForSecrets` keeps its signature, its stateless detectors and its category-only contract.

| Category | Detector (unchanged) | Range regex (`g`) | Why it differs |
|---|---|---|---|
| `aws_access_key_id` | `\b(?:AKIA\|ASIA)[A-Z0-9]{16}\b` | same + `g` | — |
| `pem_private_key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` | header same + `g`; **end extension** below | the detector matches the header only |
| `jwt` | (as today) | same + `g` | — |
| `github_token` | `gh[pousr]_[A-Za-z0-9]{20,}` | same + `g` | — |
| `slack_token` | `xox[baprs]-` | `xox[baprs]-[A-Za-z0-9-]*` | the detector is prefix-only, so the token body would survive |
| `google_api_key` | (as today) | same + `g` | — |
| `stripe_secret_key` | `(?:sk\|rk)_live_` | `(?:sk\|rk)_live_[A-Za-z0-9]*` | prefix-only detector |
| `openai_api_key` | `sk-[A-Za-z0-9]{20,}` | same + `g` | — |
| `secret_assignment` | `(?:password\|secret\|token\|api[_-]?key)\s*[=:]\s*\S{12,}` (i) | `(?<=(?:password\|secret\|token\|api[_-]?key)[ \t]*[=:][ \t]*)\S{12,}` (gi) | **value only**: the keyword stays readable; `[ \t]*` so the range never jumps a newline |

```ts
export interface SecretRange { start: number; end: number }     // half-open [start, end)
/** @throws RangeError when text.length > 10_000 (callers fail closed, like maskPii). */
export function scanForSecretsWithRanges(text: string): { categories: string[]; ranges: SecretRange[] };
```

Algorithm:
1. `categories = scanForSecrets(text)`. Same semantics as today.
2. For each table row, iterate `text.matchAll(row.range)`. `matchAll` copies the regex, so the module-level `lastIndex` is never mutated. Each match pushes `[m.index, m.index + m[0].length]`.
3. **PEM end extension**: for a header match, set `end = findPemEnd(text, headerEnd)`. This uses a *local* `/-----END [A-Z ]*PRIVATE KEY-----/g` with `lastIndex = headerEnd`. `exec` hit → `e.index + e[0].length`. No hit → `text.length`, so an unterminated block is redacted to the end of the text. The search is code, not a lazy regex, so it is linear and safe from ReDoS.
4. **Merge**: sort by `(start, end)`. Fold when `next.start <= cur.end` (overlap or adjacency, for example `token=ghp_…` hit by both `secret_assignment` and `github_token`).

**`src/security/secretRedact.ts`** (new, pure):

```ts
export const REDACTED_TOKEN = '[REDACTADO]';                 // 11 chars
export const TEXT_BUDGET = { title: 120, summary: 200, body: 2000 } as const;  // DB CHECKs
export interface RedactableContent { title: string; summary: string; body: string; fields: Record<string, unknown> }
export function redactSecretSpans(c: RedactableContent): { content: RedactableContent; ranges: number };
export function finalizeRedaction(c: RedactableContent, ranges: number): RedactableContent;
export function isSecretFree(c: RedactableContent): boolean;
export const WHOLE_REDACTION: RedactableContent;  // all three texts = REDACTED_TOKEN, fields = {}
```

- **`redactSecretSpans`**:
  - title, summary and body are each processed independently. Their ranges are replaced **right to left**, `text.slice(0, s) + REDACTED_TOKEN + text.slice(e)`, so earlier offsets stay valid.
  - `fields` is walked **per string leaf**, never on the joined JSON. The walk has the same depth limit as `maskPiiInFields` (4, deeper → `RangeError`). Keys are never rewritten.
  - The result carries the total number of ranges replaced. Nothing is clamped yet, so PII masking can run between the two steps.
- **`finalizeRedaction`** (fail-closed; any branch can only redact *more*):
  1. `ranges === 0` → `WHOLE_REDACTION`. A detection with no locatable span cannot be trusted. Examples: an assignment split across a newline, or a secret inside a `fields` key.
  2. **Clamp** each text to `TEXT_BUDGET`. Text can grow only when a matched range is shorter than 11 chars (a bare `xoxb-` or `sk_live_`) or when PII tokens grow. Let `cut = budget`. If any occurrence of `REDACTED_TOKEN` at position `p` has `p < cut < p + 11`, the clamp would split the sentinel and the field becomes `REDACTED_TOKEN` (whole-field fallback for that field). Otherwise the field becomes `slice(0, cut)`.
  3. If `!isSecretFree(result)` → `WHOLE_REDACTION` for the entire item.
- **`isSecretFree`**:
  - `scanForSecrets` returns `[]` on title, summary and body individually, on `title\nsummary\nbody`, on every string leaf, and on every key of `fields`.
  - Any throw counts as `false`.
  - The joined fields JSON is deliberately **not** scanned. JSON quoting turns a safe `password: [REDACTADO]` leaf into `[REDACTADO]"}`, which is 13 non-space chars and re-matches `\S{12,}`. That would force needless whole-field fallbacks.
- The 11-char sentinel is shorter than the 12-char minimum of `secret_assignment`. The value range is greedy to the end of the non-space run, so a replaced value never re-triggers the assignment detector. Even so, **correctness does not depend on regex edge cases**: the final verify catches anything they miss.

**Alternatives considered**:
- (a) Reuse the detector regexes with `g`. Rejected: slack and stripe would leave the token body, PEM would leave the key body, and assignments would also redact the keyword.
- (b) Redact on the joined `title\nsummary\nbody\nfieldsJson` and split back. Rejected: offsets cross field boundaries and JSON escaping, and the clamp becomes ambiguous.
- (c) No verify step. Rejected: the never-persisted guarantee would rest on hand-proved regex properties.

**Rationale**: It covers the three risks named in the exploration (PEM header-only, assignment keyword plus newline, sentinel overflow) plus the two prefix-only detectors found during design. Every uncertain branch falls back to today's behaviour (whole field), so the change can only make storage *more* informative, never less safe.

**Reversible**: Yes.

### Decision: Where redaction plugs into C1 — sanitize S2 (spans, then PII), R2 whole, repository re-check

**Choice**:
- **`QuarantineInput.redact` becomes `QuarantineRedaction`** (`'none' | 'spans' | 'whole'`, from `src/quarantine/reason.ts`). Today it is a boolean. `SanitizeBlock.redact` and `RouteOutcome.redact` (quarantine) take the same type, so TypeScript flags every call site.

| Path | Mode | Content handed to the repository |
|---|---|---|
| S1 `sanitize_failed` (bounds or detector error) | `whole` | raw item. It may be oversize, so it is never written as is |
| **S2 `secret_detected`** | **`spans`** | `s.masked` = secrets span-redacted **then** PII-masked, then `finalizeRedaction` |
| S3 `embedded_instructions` | `none` | PII-masked snapshot (C1, unchanged) |
| S4 `hash_conflict` → `duplicate_content` | `none` | masked item (C1) |
| **R2 `security_second_layer`** | **`whole`** | raw item; the repository writes the sentinel |
| R3 duplication, R4 specificity, A3 duplicate | `none` | item |
| C2 human reject `human_review: …` | `none` | item (queued items already passed S2) |

- **S2 in `src/promote/sanitize.ts`**:
  - `r = redactSecretSpans(item)`, then PII masking without the clamp, then `finalizeRedaction(masked, r.ranges)`. The block becomes `{ reason:'secret_detected', redact:'spans', leak:true, categories }`.
  - The safe content goes in `masked`, and flags become `{ leak:true, secrets, pii? }`.
  - `PromoteService` already builds the snapshot as `s.masked ? {...fetched, ...s.masked} : fetched`, so that line is unchanged.
  - **Order matters**: secrets are redacted first because PII masking could rewrite digits inside a key (phone or DNI patterns). That would leave unredactable fragments.
  - A throw anywhere is still caught by sanitize's existing `catch → failed()`, so it becomes S1 / `whole`.
  - `maskContent`'s clamp moves into a helper. S3/S4 behaviour is unchanged.
  - `BUDGET` becomes `{ ...TEXT_BUDGET, fieldsJson: 2000 }`, which removes one duplicated literal.
- **R2 stays whole-field.** The judge flagged a credential that `scanForSecrets` could not locate (otherwise S2 would have blocked), so there are no spans to keep. Running span mode would always end in `ranges === 0`, i.e. whole. Choosing `whole` directly states the outcome. The model's text is never stored (C1 R2 unchanged).
- **Repository** (`insertQuarantineSnapshot`, the single write choke point for both promotion and C2 reject) computes the stored content from the mode:
  - `none` → stored as given.
  - `whole` → `WHOLE_REDACTION`.
  - `spans` → `isSecretFree(item) ? item : WHOLE_REDACTION`. The fallback logs `logger.warn('[promote] span redaction re-check failed — whole-field fallback', { itemId })`.
- `quarantineItem` writes the **same stored content** to the staging row (C1's `MARK_QUARANTINED_SQL`), so the redaction applies to `quarantine` and `staging_item` alike.
- **`quarantine.content_hash`** is `computeContentHash(stored content + op/type/target)` when `redact !== 'none'`. Today it is the hash of the secret-bearing original, which is a brute-force oracle for low-entropy secrets (exploration residual). `quarantine` has no unique constraint on the hash, so this is safe. The staging row's `content_hash` is left untouched (C1 decision): rewriting it could collide on `UNIQUE(session_id, content_hash)` when two items in one session both redact to the sentinel. This residual on swept staging rows is documented.

**Rationale**: Redaction happens where the PII ordering can be controlled (the service), and the repository keeps a cheap independent guard. Nothing new is stored for R2 or S1, because the location is unknown or the content is oversize.

**Reversible**: Yes.

### Decision: Every quarantine insert writes classification, related, target and expiry

**Choice**: `insertQuarantineSnapshot(client, item, ctx, q: QuarantineInput): Promise<string>`. C2's `(…, reason, redact)` signature becomes `QuarantineInput`, and C2's reject passes `{ reason: HUMAN_REVIEW_PREFIX + reason, redact: 'none', decision: null, sanitizeFlags: item.sanitize_flags }`.

```sql
-- $1 project_id $2 repo_id $3 origin_session_id $4 origin_item_id $5 op $6 type
-- $7 title $8 summary $9 body $10 fields(jsonb) $11 content_hash $12 judge_reason
-- $13 author_identity $14 criterion $15 reason_code $16 related_memory_id
-- $17 target_memory_id $18 target_revision $19 retention_days
INSERT INTO quarantine
  (project_id, repo_id, origin_session_id, origin_item_id, op, type,
   title, summary, body, fields, content_hash, judge_reason, author_identity,
   criterion, reason_code, related_memory_id, target_memory_id, target_revision, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13,
        $14::quarantine_criterion, $15::quarantine_reason_code, $16, $17, $18,
        now() + make_interval(days => $19::int))
RETURNING id
```

- The `{criterion, reasonCode}` columns come from `classifyQuarantine(q.reason, q.decision?.criterion ?? null)`.
- `related_memory_id = q.decision ? q.decision.relatedMemoryId : item.related_memory_id`. A routed decision is authoritative (only R3 carries one). A human reject has no decision and keeps the related memory the reviewer saw.
- `target_* = item.target_*`.
- `PgPromotionRepository` gets a required constructor option: `new PgPromotionRepository(pool, { quarantineRetentionDays })`. Required on purpose: a default would let the config drift silently. It has two call sites (`src/index.ts`, `tests/db/promotion.integration.test.ts:208`).
- `quarantineItem` returns `Promise<string | null>`: the new quarantine id, or `null` when C2's `reviewed_at` guard rolled the transaction back.

**Reversible**: Partial (internal interface; all consumers are in this repo).

### Decision: Access rules — new `authorizeProjectMember` gate; reads for admin or author, restore for admin

**Choice**:

```ts
// src/mcp/context.ts
export type ProjectRole = 'project_admin' | 'contributor' | 'viewer' | 'service_agent';
export interface ProjectMember extends ActorIdentity { userId: string; projectRole: ProjectRole; }
interface Authorizer {
  /** Gate 2 + any membership on projectId. Platform roles do NOT bypass (C2 D4). */
  authorizeProjectMember(principal: Principal, projectId: string): Promise<ProjectMember>;
}
```

- `RdsAuthorizer.authorizeProjectMember` reuses `findEnabledUserBySubject` and `findMembershipRole`, and builds roles like `authorize`. Every failure becomes the same `AppError(PERMISSION_DENIED)`.
- `makeProjectMember(authorizer)` (`src/http/api/projectMember.ts`) validates `:projectId` as a UUID (failure → `NOT_FOUND`) and sets `res.locals.member` and `res.locals.project`.

| Route | Who | Rule |
|---|---|---|
| `GET …/quarantine` | any member | admin → all project rows; non-admin → only `author_identity = member.actorId` (`actorId` = `principal.subject` = `idp_subject`) |
| `GET …/quarantine/:id` | admin, or the author | otherwise 404 (the repository predicate, not a post-filter) |
| `POST …/quarantine/:id/restore` | `projectRole === 'project_admin'` | otherwise `NOT_FOUND`, checked **before** the body is parsed |

- An author must still be a **current member** of the project. Someone removed from the project loses access to their old quarantine rows (secure by default).
- Everyone else (other projects, non-members, disabled users, malformed ids, platform admins without membership) gets C2's byte-identical `{"error":"Not found"}`.
- Validation order: apiAuth → projectMember → uuid `:id` → role (restore) → zod. A non-admin with a bad body gets 404, not 400.
- **Mounting**: `makeApiRouter` mounts `/v1/projects/:projectId/quarantine` (projectMember → quarantine router) **before** C2's admin-only nested `/v1/projects/:projectId` router.

**Alternatives considered**:
- (a) Call `authorizeProjectAdmin` and catch the denial to fall back to the author check. Rejected: branching on exceptions, and it hides real DB errors.
- (b) Allow authors without membership. Rejected: it widens access past RBAC for no requirement.
- (c) A generic `authorizeProjectRole(minRole)`. Not needed: `ProjectMember.projectRole` answers both checks with one query.

**Rationale**: This is the second role-dependent check that C2 said would justify a broader gate. Only RDS memberships are used (project-map convention), and the opacity is the same.

**Reversible**: Yes.

### Decision: Quarantine repository SQL (project-scoped; restored and expired rows are invisible)

**Choice**: `src/db/quarantineRepository.ts`. Every statement is scoped by `q.project_id`. Active rows match `restored_at IS NULL AND (expires_at IS NULL OR expires_at > now())`. An expired row is gone from the API even before the purge runs, so behaviour never depends on the job schedule.

```sql
-- LIST  $1 project_id  $2 is_admin(bool)  $3 subject  $4 reason_code|null  $5 limit+1
SELECT q.id, q.reason_code, q.criterion, q.op, q.type, q.title,
       left(q.body, 160) AS excerpt, q.quarantined_at,
       CASE WHEN q.expires_at IS NULL THEN NULL
            ELSE GREATEST(0, ceil(extract(epoch FROM (q.expires_at - now())) / 86400))::int
       END AS days_until_expiry
FROM quarantine q
WHERE q.project_id = $1 AND q.restored_at IS NULL
  AND (q.expires_at IS NULL OR q.expires_at > now())
  AND ($2 OR q.author_identity = $3)
  AND ($4::quarantine_reason_code IS NULL OR q.reason_code = $4::quarantine_reason_code)
ORDER BY q.quarantined_at DESC, q.id DESC
LIMIT $5                                    -- rows > limit → truncated = true

-- DETAIL  $1 project_id  $2 is_admin  $3 subject  $4 quarantine_id
SELECT q.id, q.reason_code, q.criterion, q.op, q.type, q.title, q.summary, q.body, q.fields,
       q.judge_reason, q.quarantined_at, q.expires_at,
       CASE WHEN q.expires_at IS NULL THEN NULL
            ELSE GREATEST(0, ceil(extract(epoch FROM (q.expires_at - now())) / 86400))::int
       END AS days_until_expiry,
       COALESCE(u.display_name, u.email, q.author_identity) AS author,
       ss.branch AS origin_branch, ss.pr_number AS origin_pr,
       m.id AS rel_id, m.type AS rel_type, m.title AS rel_title, m.summary AS rel_summary,
       m.status AS rel_status, m.current_revision AS rel_version,
       m.origin_branch AS rel_origin_branch, m.origin_pr AS rel_origin_pr, m.updated_at AS rel_updated_at
FROM quarantine q
LEFT JOIN app_user u        ON u.idp_subject = q.author_identity
LEFT JOIN staging_session ss ON ss.id = q.origin_session_id
LEFT JOIN memory m          ON m.id = q.related_memory_id AND m.project_id = q.project_id
WHERE q.project_id = $1 AND q.id = $4 AND q.restored_at IS NULL
  AND (q.expires_at IS NULL OR q.expires_at > now())
  AND ($2 OR q.author_identity = $3)

-- PURGE (platform job, project-agnostic)
WITH d AS (DELETE FROM quarantine WHERE expires_at < now() RETURNING project_id)
SELECT project_id, count(*)::int AS count FROM d GROUP BY project_id ORDER BY project_id
```

```ts
export interface QuarantineViewer { isAdmin: boolean; subject: string }
export interface QuarantineRepository {
  list(projectId: string, v: QuarantineViewer, q: { reason: QuarantineReasonCode | null; limit: number }):
    Promise<{ rows: QuarantineListRow[]; truncated: boolean }>;
  findVisible(projectId: string, v: QuarantineViewer, id: string): Promise<QuarantineDetailRow | null>;
  claimForRestore(i: RestoreClaimInput): Promise<RestoreClaim>;          // next decision
  purgeExpired(): Promise<Array<{ projectId: string; count: number }>>;
}
```

- `is_admin` is an explicit boolean rather than "null subject means everyone", so a non-admin can never reach the unfiltered branch by accident.
- The memory join re-asserts `project_id`.
- The excerpt is cut in SQL from the already-redacted body.

**Reversible**: Yes.

### Decision: Restore — atomic claim, one-item session `restore/<id>`, same pipeline via `PromoteService.promoteItem`

**Choice**:

**1. Claim (one transaction in `claimForRestore`).** First writer wins, so a double-click or two admins produce exactly one restore.

```sql
-- R0 lock + guard  $1 quarantine_id  $2 project_id
SELECT q.id, q.repo_id, q.op, q.type, q.title, q.summary, q.body, q.fields,
       q.target_memory_id, q.target_revision, q.author_identity, ss.pr_number AS origin_pr
FROM quarantine q
JOIN repo r ON r.id = q.repo_id AND r.project_id = q.project_id          -- D3: repo gone → no row
LEFT JOIN staging_session ss ON ss.id = q.origin_session_id
WHERE q.id = $1 AND q.project_id = $2 AND q.restored_at IS NULL
  AND (q.expires_at IS NULL OR q.expires_at > now())
  AND (q.op = 'add' OR q.target_memory_id IS NOT NULL)                   -- rebuildable only
FOR UPDATE OF q
-- 0 rows → ROLLBACK, { status: 'not_found' }

-- R1 session  $1 ulid  $2 project  $3 repo  $4 'restore/' || quarantine_id  $5 opened_by  $6 origin_pr
INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, pr_number,
                             last_activity_at, expires_at)
VALUES ($1, $2, $3, $4, 'open', $5, $6, now(), now() + interval '7 days')

-- R2 item (pending; ORIGINAL author, D2)  content_hash = computeContentHash(snapshot) in JS
INSERT INTO staging_item (session_id, op, type, title, summary, body, fields, content_hash,
                          target_memory_id, target_revision, judge_state, author_identity)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'pending', $11)
RETURNING id

-- R3 label  $1 restored_by(user id)  $2 item_id  $3 quarantine_id
UPDATE quarantine SET restored_by = $1, restored_at = now(), restored_item_id = $2
WHERE id = $3 AND restored_at IS NULL                                    -- rowCount must be 1
```

- A concurrent second claim blocks on `FOR UPDATE OF q`, re-evaluates `restored_at IS NULL` after the first commit and gets 0 rows → 404. So a **restore of an already-restored row → 404**, as are restored rows in `GET`.
- `FOR UPDATE OF q` is valid with the `LEFT JOIN` because `q` is the non-nullable side.
- The session branch `restore/<uuid>` takes its own `ux_session_open` slot. It never collides with the origin branch's session and is never promoted by `/promote` (the merged path requires the default branch).

**2. Pipeline.** `src/promote/promoteService.ts` gains an exported single-item entry point. It reuses the private per-item method; nothing is duplicated.

```ts
export type ItemResult =
  | { outcome: 'applied'; memoryId: string | null; deduped: boolean }  // null only on 'already'
  | { outcome: 'queued'; itemId: string }
  | { outcome: 'quarantined'; itemId: string; quarantineId: string | null }
  | { outcome: 'skipped'; itemId: string };
export interface ItemOrigin { tenant: TenantContext; originBranch: string; originPr: number | null }
export interface PromoteServiceLike {
  promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome>;
  /** Runs sanitize → judge → route → apply for ONE item and finalizes its session. No audit:
   *  the caller audits as its own actor. */
  promoteItem(sessionId: string, itemId: string, origin: ItemOrigin): Promise<ItemResult>;
}
export function terminalStatus(c: { applied: number; queued: number; total: number }):
  'promoted' | 'rejected' | 'partially_promoted';
```

- `processItem` now returns `ItemResult` (with ids from `applyAccepted` and from `quarantineItem`'s new return value). `promote()` maps it to its unchanged counters, and both methods share `terminalStatus`, so `PromoteOutcome`, `/promote` and smoke are unchanged.
- `promoteItem` calls `fetchPromotableItems(sessionId, tenant.projectId)` (project re-asserted), picks `itemId`, runs `processItem`, then `finalizeSession(sessionId, terminalStatus(...))`.
- An absent item (only possible through a concurrent abandon) → `logger.error` with ids, then `AppError(INTERNAL)`.
- Notifications (`leak_detected`, `review_enqueued`) fire exactly as in promotion.
- **The actor never enters the pipeline**: `processItem` uses only `ApplyContext`, never a CI identity. Memory `author_identity` stays the original author.
- `ApplyContext` for restore is `{ originBranch: 'restore/<id>', originPr: <origin session pr_number> }`. This is exactly what C2's approve derives from `ss.branch` / `ss.pr_number` if the item is queued and later approved, so **both paths record the same provenance**. The origin branch stays reachable through `quarantine.origin_session_id`, and C4's retire-by-PR still matches restored memories.

**3. `QuarantineService.restore`** (`src/quarantine/quarantineService.ts`):
1. Call `claimForRestore({ projectId, quarantineId, restoredByUserId: member.userId, openedBy: member.actorId })`. A `not_found` result → `{ kind: 'not_found' }` → 404.
2. Call `promoteService.promoteItem(sessionId, itemId, origin)`. If it throws, log `logger.error('[quarantine] restore pipeline failed after claim', { quarantineId, itemId })` and rethrow → 500.
3. Map the outcome:

| `ItemResult` | Response 200 |
|---|---|
| applied | `{ outcome:'applied', memoryId }` |
| queued | `{ outcome:'queued', itemId }` (it is now in C2's review queue; finalized sessions are included there) |
| quarantined | `{ outcome:'quarantined', quarantineId }` (the **new** row; the restored row keeps its label) |
| skipped | impossible for a fresh pending item → `AppError(INTERNAL)`, logged |

4. The route audits `recordApi(member, {projectId}, 'quarantine.restore', { quarantineId, itemId, outcome, memoryId?, newQuarantineId? })` → `access_log` action `update`.

**Judge-measurement label (D2)**: `SELECT criterion, reason_code, count(*), count(*) FILTER (WHERE restored_at IS NOT NULL) FROM quarantine WHERE project_id=$1 GROUP BY 1,2`. The restored outcome is obtained by joining `restored_item_id` → `staging_item` (`promoted_at`, `judge_state`). This is documented in DEVELOPMENT.md and not exposed as an endpoint (YAGNI). The label lives as long as the row (60 days), which is the measurement window.

**Alternatives considered**:
- (a) Call `promote(sessionId, meta)` on the one-item session. Rejected: it audits as `ci`/`promote` with the CI actor and returns counters without ids.
- (b) Copy the per-item flow into the quarantine service. Rejected: a second pipeline (proposal risk "restore bypasses the pipeline").
- (c) Mark `restored_*` after the pipeline. Rejected: two concurrent restores could both create items.
- (d) Use the original branch as the session branch. Rejected: it collides with that branch's open session and would be promoted by its PR.

**Residual risks (documented)**:
- If the DB fails after the claim commits, the restored item stays `pending` in an open `restore/<id>` session, and a retry gets 404. The error is logged with both ids.
- An agent working on a git branch literally named `restore/<uuid>` could add an unrelated item to that open session during the restore window. `promoteItem` processes only the claimed item id, so the stray item is never applied.

**Reversible**: Partial. The restored memory or queue item follows the normal lifecycle.

### Decision: Jobs router (contract with C4), purge job, script and production guard

**Choice**: `src/jobs/jobsRouter.ts`:

```ts
export interface JobResult { job: string; count: number; detail?: Record<string, number> }
export interface JobsRouterDeps {
  jobs: Record<string, () => Promise<JobResult>>;
  token?: string;
  enabled: boolean;
  audit: Pick<AuditLogger, 'recordJob'>;
}
export function makeJobsRouter(deps: JobsRouterDeps): express.Router;   // mounted at /internal/jobs
```

- Every response sets `Cache-Control: no-store`. Every refusal is the **same** `404 {"error":"Not found"}`: disabled router, missing or bad token, unknown job, wrong method, any other path. The router ends with a catch-all, so nothing under `/internal/jobs` falls through to static or SPA handling.
- **Open mode** (`enabled` and no `token`) is honoured only when `process.env.NODE_ENV !== 'production'`, read at factory time. In production the router behaves as disabled. This is the third layer of the guard.
- **Token mode**:
  - Parse `Authorization: Bearer <t>`, then `timingSafeEqual(sha256(t), sha256(token))`. Hashing first gives equal-length buffers, so the comparison is constant-time and does not leak the length.
  - A token, once configured, is required in every environment, including development.
- `POST /:job`: the job must match `^[a-z0-9-]{1,64}$` **and** `Object.hasOwn(deps.jobs, job)`. Then:
  - `result = await fn()`, then `audit.recordJob({ ...result, trigger: 'http' })`, then `200 result`.
  - Errors go `next(err)` → terminal 500, which is logged.
  - The audit runs after success, like `recordWrite`. An audit failure → 500.
- `AuditLogger.recordJob(p: { job: string; count: number; detail?: Record<string, number>; trigger: 'http' | 'script' })` writes an `access_log` row: `{ actor_identity: 'jobs:' + trigger, actor_kind: 'system', action: 'admin', project_id: null, detail: { job, count, detail, trigger } }`. The detail holds counts keyed by project id, never content.
- **Enablement** (`src/index.ts`): `jobsEnabled = config.NODE_ENV === 'development' || config.JOBS_TOKEN !== undefined`, so `test` and `production` without a token are disabled.
- **Config** (`src/config/index.ts`):
  - `JOBS_TOKEN: z.string().trim().min(32).optional()`. A short token fails at boot in every environment.
  - `QUARANTINE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(60)`. An empty string coerces to 0 and fails `min(1)`.
  - No `superRefine` is needed. Production without a token is *disabled*, not an error, and is enforced by the three layers above: config computation, composition root and router.
- **Purge**: `src/quarantine/purge.ts` exports `purgeExpiredQuarantine(repo: Pick<QuarantineRepository, 'purgeExpired'>): Promise<JobResult>`, returning `{ job: 'quarantine-purge', count: Σ, detail: { [projectId]: n } }`. It is a plain function, so the script does not need to build the restore service's dependencies.
- **Composition**:
  - `createApp(services, { …, jobs?: JobsRouterDeps })` mounts `app.use('/internal/jobs', makeJobsRouter(jobs))` after `/promote` and before `/api`.
  - `index.ts` always passes `jobs: { jobs: { 'quarantine-purge': () => purgeExpiredQuarantine(quarantineRepository) }, token: config.JOBS_TOKEN, enabled: jobsEnabled, audit: auditLogger }`. C4 adds `'revalidation-sweep'` to this map.
- **Script**: `scripts/jobs/quarantine-purge.ts` follows the `migrate.ts` pattern:
  - It reads `DATABASE_URL` directly (no `loadConfig`, so no Cognito vars are needed) and uses the main-module guard.
  - It calls `createPool → purgeExpiredQuarantine(new PgQuarantineRepository(pool))`, then `new RdsAuditLogger(new PgAuthRepository(pool)).recordJob({ ...r, trigger: 'script' })`, prints the JSON result, closes the pool, and exits 1 on error after logging.
  - `package.json` gets `"job:quarantine-purge": "tsx scripts/jobs/quarantine-purge.ts"`.
- **Scheduling**: EventBridge Scheduler → HTTPS `POST /internal/jobs/quarantine-purge` with the bearer token held in an EventBridge connection secret. Documented, not implemented.

**Alternatives considered**:
- (a) 401 for a bad token. Rejected: it reveals the endpoint (no-enumeration convention).
- (b) A `JobsService` class. Rejected: a name → function map is the whole registry. C4 adds one line.
- (c) Purge only from the script. Rejected: the Fargate image does not ship tsx, so prod scheduling needs the HTTP path.

**Reversible**: Yes.

### Decision: Quarantine routes and DTOs

**Choice**: `src/http/api/quarantineRoutes.ts` defines `makeQuarantineRouter({ quarantineService, auditLogger })`, mounted with `mergeParams` behind `projectMember`.

```ts
const QuarantineQuery = z.object({
  reason: z.enum(QUARANTINE_REASON_CODES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();
const RestoreBody = z.object({}).strict();          // undefined body → {}

interface QuarantineItemDto { id: string; reasonCode: QuarantineReasonCode | null; criterion: QuarantineCriterion | null;
  op: 'add'|'amend'|'supersede'|'deprecate'; type: MemoryType; title: string; excerpt: string;
  quarantinedAt: string; daysUntilExpiry: number | null }
interface QuarantineListDto { items: QuarantineItemDto[]; truncated: boolean }
interface QuarantineDetailDto extends QuarantineItemDto { summary: string; body: string;
  fields: Record<string, unknown>; judgeReason: string; author: string; expiresAt: string | null;
  originBranch: string | null; originPr: number | null; related: MemoryRefDto | null; canRestore: boolean }
type RestoreResponseDto =
  | { outcome: 'applied'; memoryId?: string } | { outcome: 'queued'; itemId: string }
  | { outcome: 'quarantined'; quarantineId?: string };
```

`MemoryRefDto` is C2's. `ApiAction` gains `'quarantine.list' | 'quarantine.read' | 'quarantine.restore'`, and `ApiAuditDetail` gains `quarantineId?`, `outcome?` and `newQuarantineId?` (`filter` carries the reason). `RdsAuditLogger.recordApi` maps `restore` to `update`, alongside C2's approve and reject. Audit runs after success only, and denials are never audited (C2).

**Reversible**: Yes. The DTOs are additive.

## Data Flow

```
Promotion (C1 + C3)
 staged item ─▶ sanitizeItem
                 S2 secret: redactSecretSpans ─▶ PII mask ─▶ finalizeRedaction(clamp, verify, whole fallback)
                            └▶ quarantineItem(redact:'spans', content = safe snapshot)
                 R2 second layer ─▶ quarantineItem(redact:'whole')
                                        │
          insertQuarantineSnapshot: stored = none|spans(re-check isSecretFree)|whole
             classifyQuarantine(reason, criterion) ─▶ INSERT … criterion, reason_code, related,
             target, expires_at = now()+QUARANTINE_RETENTION_DAYS RETURNING id
             + MARK_QUARANTINED (same stored content on staging_item)

REST (C2 chain)
 /api/v1/projects/:pid/quarantine ─▶ apiAuth ─▶ projectMember (uuid, Gate 2, any role) ──deny──▶ 404
    GET  /            ─▶ zod ─▶ QuarantineService.list(viewer{isAdmin, subject}) ─▶ LIST SQL ─▶ recordApi(read)
    GET  /:id         ─▶ uuid ─▶ findVisible (admin OR author) ─null─▶ 404 ─▶ recordApi(read)
    POST /:id/restore ─▶ uuid ─▶ role==project_admin? ─no─▶ 404 ─▶ zod {} ─▶ QuarantineService.restore
         claimForRestore: BEGIN lock q (active, repo ok, rebuildable) → session restore/<id>
                          → staging_item pending (orig author) → restored_* COMMIT
         promoteService.promoteItem(session, item, origin) ─▶ processItem (same pipeline) ─▶ finalizeSession
         ─▶ {applied|queued|quarantined} ─▶ recordApi(update)

Jobs
 EventBridge / curl ─▶ POST /internal/jobs/:job ─▶ enabled? token (sha256 + timingSafeEqual)? known? ──no──▶ 404
                      ─▶ jobs[job]() ─▶ purgeExpiredQuarantine ─▶ DELETE … expires_at < now() (per-project counts)
                      ─▶ recordJob(trigger:'http') ─▶ 200 JobResult
 pnpm job:quarantine-purge ─▶ same function ─▶ recordJob(trigger:'script')
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `QUARANTINE_CRITERIA`, `QUARANTINE_REASON_CODES`, `QuarantineCriterion`, `QuarantineReasonCode`, `QuarantineRedaction`, `HUMAN_REVIEW_PREFIX`, `classifyQuarantine` | const / type / func | `src/quarantine/reason.ts` | `src/db/promotionRepository.ts`, `src/db/quarantineRepository.ts`, `src/promote/sanitize.ts`, `src/promote/routing.ts`, `src/http/api/quarantineRoutes.ts`, `src/http/api/types.ts` |
| `SecretRange`, `scanForSecretsWithRanges` | type / func | `src/security/secretScan.ts` | `src/security/secretRedact.ts` |
| `REDACTED_TOKEN`, `TEXT_BUDGET`, `RedactableContent`, `redactSecretSpans`, `finalizeRedaction`, `isSecretFree`, `WHOLE_REDACTION` | const / type / func | `src/security/secretRedact.ts` | `src/promote/sanitize.ts`, `src/db/promotionRepository.ts`, `tests/db/secretNeverPersisted.integration.test.ts` |
| `SanitizeBlock.redact`, `RouteOutcome.redact` (→ `QuarantineRedaction`) | type | `src/promote/sanitize.ts`, `src/promote/routing.ts` | `src/promote/promoteService.ts` |
| `QuarantineInput.redact` (→ `QuarantineRedaction`), `quarantineItem(): Promise<string \| null>`, `PgPromotionRepository(pool, { quarantineRetentionDays })` | type / interface | `src/db/promotionRepository.ts` | `src/promote/promoteService.ts`, `src/index.ts`, `tests/promote/fakes.ts`, `tests/http/promote.test.ts` |
| `ItemResult`, `ItemOrigin`, `PromoteServiceLike.promoteItem`, `terminalStatus` | type / interface / func | `src/promote/promoteService.ts` | `src/quarantine/quarantineService.ts`, `tests/auth/fakes.ts`, `tests/quarantine/fakes.ts` |
| `QuarantineRepository`, `PgQuarantineRepository`, `QuarantineViewer`, `RestoreClaimInput`, `RestoreClaim`, row types | interface / class | `src/db/quarantineRepository.ts` | `src/quarantine/quarantineService.ts`, `src/quarantine/purge.ts`, `src/index.ts`, `scripts/jobs/quarantine-purge.ts` |
| `QuarantineServiceLike`, `QuarantineService`, `RestoreOutcome` | interface / class | `src/quarantine/quarantineService.ts` | `src/http/api/quarantineRoutes.ts`, `src/http/api/types.ts` (`ApiRouterDeps`), `src/mcp/context.ts` (`AppServices`), `src/index.ts` |
| `purgeExpiredQuarantine` | func | `src/quarantine/purge.ts` | `src/index.ts`, `scripts/jobs/quarantine-purge.ts` |
| `JobResult`, `JobsRouterDeps`, `makeJobsRouter` | type / func | `src/jobs/jobsRouter.ts` | `src/http/app.ts`, `src/index.ts`, `src/quarantine/purge.ts`, **C4** (`revalidation-sweep`) |
| `ProjectRole`, `ProjectMember`, `Authorizer.authorizeProjectMember`, `AuditLogger.recordJob`, `ApiAction += quarantine.*`, `ApiAuditDetail += quarantineId/outcome/newQuarantineId` | type / interface | `src/mcp/context.ts` | `src/auth/authorizer.ts`, `src/auth/auditLogger.ts`, `src/http/api/projectMember.ts`, `src/http/api/quarantineRoutes.ts`, `src/jobs/jobsRouter.ts`, `tests/auth/fakes.ts`, `tests/promote/fakes.ts` |
| `makeProjectMember`, `makeQuarantineRouter` | func | `src/http/api/projectMember.ts`, `src/http/api/quarantineRoutes.ts` | `src/http/api/router.ts` |
| `QuarantineItemDto`, `QuarantineListDto`, `QuarantineDetailDto`, `RestoreResponseDto`, `ApiLocals.member` | type | `src/http/api/types.ts` | `src/quarantine/quarantineService.ts`, `src/http/api/quarantineRoutes.ts`, `packages/web` (C7) |
| `Config.QUARANTINE_RETENTION_DAYS`, `Config.JOBS_TOKEN` | config | `src/config/index.ts` | `src/index.ts` |
| `POST /internal/jobs/:job`, `GET/POST /api/v1/projects/:projectId/quarantine[/:id[/restore]]` | endpoint | `src/jobs/jobsRouter.ts`, `src/http/api/quarantineRoutes.ts` | EventBridge (doc), `packages/web` (C7), `scripts/smoke.ts` |

## File Changes

Precondition: C2 has been implemented, so `src/http/api/*`, `insertQuarantineSnapshot`, `recordApi` and `authorizeProjectAdmin` exist.

Batches:
- **A** runs first.
- **B**, **E** and **F** run in parallel after A. Their file sets are disjoint.
- **C** needs B. **D** needs C.
- **G** needs D and F.
- **H** needs E and G.
- **I** (docs) can run in parallel with H.

A file that appears in two batches is touched sequentially: `src/mcp/context.ts` A→H, `src/http/api/types.ts` A→G, `tests/auth/fakes.ts` F→H. `tsc` is green only after F, because interface additions in A are implemented in F (same pattern as C2).

| File | Action | Description |
|------|--------|-------------|
| **A — Schema, classifier, config, contracts** | | |
| `migrations/0008_quarantine_management.sql` | Create | SQL above |
| `src/quarantine/reason.ts` | Create | Enum consts and types, `QuarantineRedaction`, `HUMAN_REVIEW_PREFIX`, `classifyQuarantine` |
| `src/config/index.ts` | Modify | `QUARANTINE_RETENTION_DAYS` (1..3650, default 60), `JOBS_TOKEN` (trim, min 32, optional) |
| `src/mcp/context.ts` | Modify | `ProjectRole`, `ProjectMember`, `Authorizer.authorizeProjectMember`, `AuditLogger.recordJob`, `ApiAction` + 3 quarantine actions, `ApiAuditDetail` + `quarantineId`/`outcome`/`newQuarantineId` |
| `src/http/api/types.ts` | Modify | Quarantine DTOs; `ApiLocals.member?: ProjectMember` |
| `tests/quarantine/reason.test.ts` | Create | Shared fixture table → `classifyQuarantine` (every row, including duplicate with and without `duplication`, the `human_review:` prefix, an unknown reason) |
| `tests/config/quarantineConfig.test.ts` | Create | Retention default 60; `0`, `''`, `-1`, `1.5`, `abc`, `3651` → exit(1); `JOBS_TOKEN` absent ok; 31 chars → exit(1); 32 ok (spy pattern of `promoteConfig.test.ts`) |
| `tests/db/quarantineMgmt.migrate.integration.test.ts` | Create | Columns, enums, FKs `confdeltype='n'`, `ix_quarantine_list`; seed legacy rows with `criterion NULL` for every reason (duplicate with a live `duplication` item, duplicate with a swept item, `human_review: x`, `judge_rejected`, `stale_target`) → re-run the file → mapping equals the reason.test fixture, related/target copied via the join, `expires_at = quarantined_at + 60d`; second re-run leaves the rows unchanged; ledger row |
| **B — Span redaction + sanitize/routing** | | |
| `src/security/secretScan.ts` | Modify | `range` regex per category, `scanForSecretsWithRanges` (PEM end extension, merge, 10k bound) |
| `src/security/secretRedact.ts` | Create | `REDACTED_TOKEN`, `TEXT_BUDGET`, `redactSecretSpans`, `finalizeRedaction`, `isSecretFree`, `WHOLE_REDACTION` |
| `src/promote/sanitize.ts` | Modify | S2 → spans, then PII, then finalize, `redact:'spans'`, safe content in `masked`; S1 `'whole'`, S3 `'none'`; clamp helper; `BUDGET` from `TEXT_BUDGET` |
| `src/promote/routing.ts` | Modify | Quarantine `redact: QuarantineRedaction`; R2 `'whole'`, R3/R4 `'none'` |
| `tests/security/secretRanges.test.ts` | Create | Per category: a range exists wherever the detector hits; slack and stripe bodies covered; PEM with END / without END / two blocks; assignment value only (`password=…` keeps `password=`), and `password:\n value` gives no range; overlap merge; adjacency merge; 10_001 chars → RangeError; `matchAll` twice gives the same result (no `lastIndex` leak) |
| `tests/security/secretRedact.test.ts` | Create | Right-to-left multi-span replace; per-leaf fields with key untouched; depth 5 → RangeError; `ranges=0` → whole; clamp that splits the sentinel → whole field; clamp outside the sentinel → slice; secret in a key → whole; the `[REDACTADO]` leaf does not trip verify; output of every fixture passes `scanForSecrets` = [] per unit |
| `tests/promote/sanitize.test.ts` | Modify | S2 returns span-redacted + PII-masked `masked`, `redact:'spans'`, flags include `pii`; secret plus a phone-like digit run inside the key → no fragment survives; S1 `'whole'`; S3 `'none'` |
| `tests/promote/routing.test.ts` | Modify | R2 `redact:'whole'`; R3/R4 `'none'` |
| **E — Jobs router** | | |
| `src/jobs/jobsRouter.ts` | Create | `JobResult`, `JobsRouterDeps`, `makeJobsRouter` (decision above) |
| `tests/jobs/jobsRouter.test.ts` | Create | supertest on `express()` + router: disabled → 404 on all; token: none / wrong / `Basic` / right → 404 / 404 / 404 / 200; same-length wrong token → 404; open mode under `NODE_ENV=production` → 404; unknown job, `__proto__`, `toString`, uppercase → 404; GET → 404; job throws → 500 and no audit; audit called once with `trigger:'http'`; `Cache-Control: no-store`; byte-identical 404 bodies |
| **F — Auth + audit implementations** | | |
| `src/auth/authorizer.ts` | Modify | `authorizeProjectMember` |
| `src/auth/auditLogger.ts` | Modify | `recordJob`; `recordApi` maps `quarantine.restore` → `update` |
| `tests/auth/fakes.ts` | Modify | Stub authorizer `authorizeProjectMember`; stub audit `recordJob` |
| `tests/auth/authorizeProjectMember.test.ts` | Create | Each role → `projectRole`; no membership, disabled user, absent user, platform_admin without membership → identical PERMISSION_DENIED |
| `tests/auth/auditLogger.test.ts` | Modify | `recordJob` row (system/admin/null project, counts only); restore → `update` |
| **C — DB layer** (needs B) | | |
| `src/db/promotionRepository.ts` | Modify | Ctor option `quarantineRetentionDays`; `QuarantineInput.redact` mode; `insertQuarantineSnapshot(client, item, ctx, q)` → stored content (none / spans re-check / whole `[REDACTADO]`), recomputed hash when redacted, classification, related, target, `expires_at`, `RETURNING id`; `quarantineItem` → `string \| null` and writes the same stored content to staging; C2 reject passes `{ reason: HUMAN_REVIEW_PREFIX + reason, redact:'none', decision:null, … }` |
| `src/db/quarantineRepository.ts` | Create | `QuarantineRepository` + `PgQuarantineRepository` (LIST, DETAIL, claim R0–R3, PURGE) |
| `tests/promote/fakes.ts` | Modify | `FakePromotionRepository.quarantineItem` returns a generated id and records `redact` mode |
| `tests/http/promote.test.ts` | Modify | Fake repo literal: `quarantineItem` returns an id |
| `tests/db/promotion.integration.test.ts` | Modify | Existing redact tests (817-893): `redact:'whole'` and sentinel `'[REDACTADO]'` (was the English sentinel); `quarantineItem` at 786 also asserts `criterion='judge'`, `reason_code='judge_rejected'`, `expires_at ≈ now()+retention`; new: `'spans'` with already-redacted content stored verbatim; `'spans'` with a residual secret → whole fallback; redacted `content_hash` ≠ original; target/related columns; returned id equals the row id; constructor gets `{ quarantineRetentionDays: 60 }` |
| `tests/db/quarantineRepository.integration.test.ts` | Create | List: project scoping, author filter for non-admin, reason filter, restored and expired rows hidden, order, `truncated`, excerpt ≤160, `days_until_expiry` (59.5d → 60, null expiry → null); detail: admin vs author vs other member → null, related ref only same project; claim: happy path writes session/item/label in one txn; second claim → not_found; concurrent claims (`Promise.all`, two clients) → exactly one claimed; repo deleted → not_found; non-add without target → not_found; expired → not_found; purge: deletes only `expires_at < now()`, per-project counts, NULL expiry kept |
| **D — Services** (needs C) | | |
| `src/promote/promoteService.ts` | Modify | `ItemResult`, `processItem` returns it, `promoteItem`, `terminalStatus`; S4 conflict and A3 `redact:'none'` |
| `src/quarantine/quarantineService.ts` | Create | `QuarantineServiceLike`, `QuarantineService` (list/get with viewer from the member, restore flow and outcome mapping, DTO mapping) |
| `src/quarantine/purge.ts` | Create | `purgeExpiredQuarantine` |
| `tests/promote/promoteService.test.ts` | Modify | Redact assertions (`true` → `'spans'`/`'whole'`); `promote()` outcome unchanged |
| `tests/promote/promoteVerdict.test.ts` | Modify | R2 `'whole'`; HU-05 secret → `'spans'` snapshot without the secret |
| `tests/promote/promoteItem.test.ts` | Create | `promoteItem`: applied (memoryId), queued, quarantined (new id), leak notify fired, session finalized with the right status, item absent → INTERNAL; actor never consulted; `terminalStatus` table |
| `tests/quarantine/fakes.ts` | Create | `FakeQuarantineRepository`, scripted `promoteItem` |
| `tests/quarantine/quarantineService.test.ts` | Create | Viewer mapping (non-admin always sends `isAdmin:false` with its subject); restore outcome mapping; not_found passthrough; pipeline throw after claim → logged with ids and rethrown; `skipped` → INTERNAL |
| `tests/quarantine/purge.test.ts` | Create | Sum and per-project detail; empty → `{count:0, detail:{}}` |
| **G — REST routes** (needs D, F) | | |
| `src/http/api/projectMember.ts` | Create | `makeProjectMember` |
| `src/http/api/quarantineRoutes.ts` | Create | 3 routes, zod, role check, audit after success |
| `src/http/api/router.ts` | Modify | Mount the quarantine router before the admin nested router |
| `src/http/api/types.ts` | Modify | `ApiRouterDeps.quarantineService: QuarantineServiceLike` |
| `tests/http/api/helpers.ts` | Modify | `makeApiTestApp` accepts a quarantine service fake |
| `tests/http/api/quarantine.test.ts` | Create | Routes: list/detail DTO shape, reason filter validation (`reason=foo` → 400 for a member), restore 200 per outcome, restore audit detail, audit only after success |
| `tests/http/api/quarantinePermissions.test.ts` | Create | Opacity matrix (HU-10.4) |
| **H — Composition, script, end-to-end** (needs E, G) | | |
| `src/mcp/context.ts` | Modify | `AppServices.quarantineService: QuarantineServiceLike` |
| `src/http/app.ts` | Modify | `CreateAppOptions.jobs?: JobsRouterDeps`; mount `/internal/jobs` after `/promote`, before `/api` |
| `src/index.ts` | Modify | `PgPromotionRepository(pool, { quarantineRetentionDays })`, `PgQuarantineRepository`, `QuarantineService`, jobs map and `jobsEnabled`, `createApp({… jobs})` |
| `scripts/jobs/quarantine-purge.ts` | Create | tsx CLI (DATABASE_URL, main-module guard, purge, then `recordJob('script')`, exit 1 on error) |
| `package.json` | Modify | `"job:quarantine-purge": "tsx scripts/jobs/quarantine-purge.ts"` |
| `tests/auth/fakes.ts` | Modify | `makeStubAuthServices`: `quarantineService` stub, `promoteService.promoteItem` stub |
| `tests/http/app.jobs.test.ts` | Create | `createApp` with jobs: mounted path works; without the `jobs` option → no route (404); `/internal/jobs/x` never reaches the SPA fallback when `webStaticDir` is set |
| `tests/db/restore.integration.test.ts` | Create | Real repos + `PromoteService` (DeterministicJudge): HU-10.2 end to end (see Test Strategy) |
| `tests/db/secretNeverPersisted.integration.test.ts` | Create | `information_schema` scan (see Test Strategy) |
| `scripts/smoke.ts` | Modify | `GET /api/v1/projects/<seed project>/quarantine` as `tl@demo.local` → 200; `POST /internal/jobs/quarantine-purge` (dev open mode) → 200 `{job, count}` |
| **I — Docs** | | |
| `README.md` | Modify | Config rows `QUARANTINE_RETENTION_DAYS` (60) and `JOBS_TOKEN` (optional, ≥32, jobs disabled in prod without it) |
| `DEVELOPMENT.md` | Modify | Quarantine API + restore; `pnpm job:quarantine-purge`; EventBridge Scheduler (HTTPS target + connection secret) runbook; backfill note (rows older than 60 days become purgeable at once); judge-measurement query |

## New Modules

None. `src/quarantine` holds three files and `src/jobs` holds one. Neither has its own manifest or 10+ source files.

## Test Strategy

The runner is vitest with tests in `tests/**/*.test.ts`. DB-gated suites follow the `*.integration.test.ts` skip-without-`DATABASE_URL` pattern. HTTP tests use supertest.

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| **HU-10.1 view redacted content + reason** | integration (`quarantineRepository`, `restore`) + unit (routes) | An item with an AWS key in the body, a PEM block in the summary and an email is promoted. The quarantine row shows the surrounding text, `[REDACTADO]` in place of each secret, `[EMAIL]`, `reason_code='secret_detected'`, `criterion='pipeline'`. The list item shows `excerpt` ≤160 chars, `daysUntilExpiry` 60, and type and title. The detail shows `judgeReason`, the related memory ref for an R3 duplicate, and `canRestore` true for admin / false for author. R2 row → whole `[REDACTADO]`, `criterion='judge'`, `reason_code='secret_detected'` | DeterministicJudge rule 1 triggers R2 |
| **HU-10.2 restore re-runs pipeline + judge and records the label** | integration (`restore.integration`) | (1) A quarantine row with `reason_code='judge_rejected'` whose content passes the DeterministicJudge (a false positive, seeded directly as a quarantine row) → `outcome:'applied'`, memory exists with the **original author**, `origin_branch='restore/<id>'`, `origin_pr` = the origin PR, and the quarantine row has `restored_by`=TL, `restored_at`, `restored_item_id` = the new item. (2) A `decision` type → `queued`, and the item appears in C2's queue (finalized session included). (3) A secret-redacted row → re-judged; DeterministicJudge `specificity` on the `[REDACTADO]` body → `quarantined` with a **new** quarantine id, while the old row keeps its label. (4) Restore again → 404; GET of the restored row → 404. (5) Two concurrent restores → one 200, one 404, exactly one staging item. (6) Repo deleted → 404. (7) Amend row with a target → restored with the target and revision; if the target moved, the item is queued as stale (HU-11.3 path). (8) `access_log` has one `update` row with `{api:'quarantine.restore', quarantineId, outcome}` and the judge is called exactly once | Proves "same pipeline": spy judge/notifier injected into the real `PromoteService` |
| **HU-10.3 purge deletes expired** | integration + unit (router, purge) | Rows with expiry -1d, +1d and NULL → the job deletes only the -1d row; the response is `{job:'quarantine-purge', count:1, detail:{[projectId]:1}}`; `access_log` row `system/admin`, `trigger:'http'`; a re-run gives `count:0`. Script path: `purgeExpiredQuarantine` + `recordJob('script')`. New inserts get `expires_at = now() + QUARANTINE_RETENTION_DAYS` (set to 7 in the test, ±5s) | `jobsRouter.test`, `purge.test`, `promotion.integration` |
| **HU-10.4 foreign user denied** | unit (`quarantinePermissions.test`) + integration | A contributor who is not the author, a viewer, another project's admin, a platform_admin without membership, a disabled user, a malformed project uuid, a random project uuid, and a malformed quarantine id → byte-identical 404 on list/detail/restore (list for a non-author member → 200 with **no** foreign rows); an author who is not admin → restore 404; a non-admin restore with an invalid body → 404, not 400; no `access_log` rows on any denial | `InMemoryAuthRepository` with memberships |
| **Secret never persisted** | integration (`secretNeverPersisted`) | Seed a staged item carrying sentinels: an AWS key, a PEM block (header, base64 body line, END), `api_key=` + a 24-char value, a slack token with body, the same AWS key in a `fields` leaf, and a second key used as a `fields` **key**. Also seed an R2 item ("password is hunter2…"). Run `PromoteService.promote`, then restore both rows. Then enumerate `information_schema.columns WHERE table_schema='public' AND (data_type IN ('text','character varying','json','jsonb') OR udt_name = '_text')` and run, for each column and each sentinel fragment (the full secret plus distinctive substrings ≥8 chars such as the key body, the PEM body line, the token body, `hunter2`): `SELECT count(*) FROM <quoted ident> WHERE <col>::text LIKE '%' \|\| $1 \|\| '%'` → expect 0. Identifiers are quoted with `"…".replace(/"/g,'""')`; values are parameters | Covers quarantine, staging_item, memory, memory_revision, access_log; also asserts the surrounding non-secret text **did** survive (not a whole-field false pass) |
| `scanForSecretsWithRanges` / `secretRedact` | unit | See batch B rows; property-style loop over all category fixtures: `isSecretFree(finalize(redact(x)))` is always true | Pure |
| Sanitize / routing redaction modes | unit | S1 whole, S2 spans (+PII after secrets), S3 none, R2 whole, R3/R4 none | Updated existing tests |
| Repository write choke point | integration (`promotion.integration`) | `'whole'` → `[REDACTADO]` ×3 and `{}` in **both** tables (existing tests, new sentinel); `'spans'` residual → whole + warn; classification columns per reason; C2 reject → `human_review`/`human_rejected` | |
| Classifier ↔ backfill parity | unit + integration | One fixture table drives `reason.test` and the migration backfill test | No drift |
| 0008 migration | integration | Columns, enums, FKs, index, backfill incl. swept-item fallback, idempotent re-apply, ledger | DB-gated |
| `promoteItem` | unit | Outcomes with ids, finalize status, no audit, notifications as in promotion | Shared fakes |
| Jobs router + prod guard | unit | Disabled / token / open-mode-in-prod / unknown job / prototype keys / constant-time path (same-length wrong token) / audit after success only | Restore `process.env` in `afterEach` |
| Config | unit | `QUARANTINE_RETENTION_DAYS` and `JOBS_TOKEN` matrices | Spy pattern |
| Composition | unit (`app.jobs.test`) + smoke | Mount order, no SPA fall-through; smoke lists quarantine as TL and runs the purge in dev | `pnpm smoke` |

**Existing tests to update** (complete list):
- `tests/db/promotion.integration.test.ts`: sentinel `'[REDACTED: secret detected]'` → `'[REDACTADO]'` (lines 851-853, 887-888); `redact: true/false` → `'whole'/'none'`; constructor option; new column assertions.
- `tests/promote/sanitize.test.ts`: S2 shape and modes.
- `tests/promote/routing.test.ts`: R2/R3/R4 modes.
- `tests/promote/promoteService.test.ts`, `tests/promote/promoteVerdict.test.ts`: redact assertions.
- `tests/promote/fakes.ts`: `quarantineItem` return value; `FakeAuditLogger.recordJob`.
- `tests/http/promote.test.ts`: fake repo literal.
- `tests/auth/fakes.ts`: `authorizeProjectMember`, `recordJob`, `promoteItem`, `quarantineService`.
- `tests/auth/auditLogger.test.ts`: `recordJob`; restore mapping.
- C2's `tests/db/review.integration.test.ts` reject case: also assert `criterion='human_review'`, `reason_code='human_rejected'`.
