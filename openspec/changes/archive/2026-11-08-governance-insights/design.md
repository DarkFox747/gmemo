# Design: Governance insights — dashboard, activity and staging views

## Technical Approach

Three **read-only** views for the project's tech lead, built on tables that already exist
(`memory`, `staging_session`, `staging_item`, `quarantine`, `access_log`, `app_user`, `repo`).
One additive index migration (0011), no new dependency, no write path touched.

- **Server**: one read model, `PgInsightsRepository` (`src/db/insightsRepository.ts`), shaped
  like `PgAdminSummaryRepository` (top-level SQL constants, `$N` parameters only, every
  statement scoped by `project_id`, explicit column lists, raw rows mapped to DTOs). Pure,
  DB-free logic (judge rates, audit-row → event mapping, cursor parsing) lives in
  `src/db/insightsMapping.ts` so it is unit-tested without Postgres (precedent: the exported
  cursor codec in `memoryAdminRepository.ts`).
- **REST**: one route file, `src/http/api/insightsRoutes.ts`, mounted in the existing
  `/v1/projects/:projectId` chain **after `makeProjectAdmin`** (same place as
  `makeAdminRoutes`), so non-admins never reach validation and get the uniform opaque 404.
  Handlers follow `adminRoutes.ts`: `adminContext` → `parseOrInvalid(strict zod)` →
  repository → `auditLogger.recordApi(...)` after success → `200`.
- **Web**: three screens (`HomeScreen`, `ActivityScreen`, `StagingScreen`), one new decorative
  bar component (`StatBar`), one pure helper module (`lib/insights.ts`). Hash routes, sidebar
  entries, labels and the typed client are minimal additive edits.

Mapping to the proposal: Inicio = `GET …/dashboard`, Actividad = `GET …/activity`,
Área de preparación = `GET …/staging`.

## Architecture Decisions

### Decision: One read repository + one route file for the three views

**Choice**: `InsightsRepository` (3 methods: `getDashboard`, `listActivity`, `listStaging`) and
`makeInsightsRoutes`, wired as a single new dependency `insightsRepository` in `ApiRouterDeps`
and `AppServices`.
**Alternatives considered**: (a) three repositories/three deps — triples the edits to the
shared files (`types.ts`, `context.ts`, `index.ts`, test helpers) that two concurrent changes
also touch; (b) a service layer — there is no orchestration, only reads (YAGNI); (c) reusing
`ReviewQueueRepository.countQueue` through a service — would need a new service just to call it.
**Rationale**: matches the C7 admin-summary precedent (a per-screen read model as a repository
consumed directly by the route), minimizes the surface of shared-file edits, keeps SQL in `src/db`.
**Reversible**: Yes — additive files; removing the dep and the mount reverts it.

### Decision: Queue membership reuses `QUEUED_PREDICATE`

**Choice**: the dashboard queue counters and the staging item state import the exported
`QUEUED_PREDICATE` fragment from `src/db/reviewQueueRepository.ts`.
**Alternatives considered**: re-writing the predicate (drift risk); calling `countQueue`
(cross-repository dependency).
**Rationale**: the fragment is already shared with `PgPromotionRepository` (established local
pattern); the dashboard number then equals the review-queue badge by construction.
**Reversible**: Yes.

### Decision: Judge metrics follow the project's existing FP/FN convention (TT-06)

**Choice**: "positive" = the judge **held the unit back** (`judge_state ∈ {uncertain, rejected}`
as persisted, i.e. judge verdict + confidence threshold, exactly `flagged` in
`scripts/eval.ts`). Ground truth comes only from stored human labels (see *Metric definitions*).
**Alternatives considered**: "positive = accepted" (inverts the meaning used by
`docs/demo/metricas.md`, `REPORTE-E4.md` and the quarantine spec); counting R7 mandatory-review
routing as "held back" (that is a type policy, not the judge — eval does not count it either).
**Rationale**: the live indicators must be comparable with the synthetic ones already published.
**Reversible**: Yes — computed at read time, nothing stored.

### Decision: Activity pagination is keyset on `access_log.id`

**Choice**: newest first, `ORDER BY id DESC`, `nextCursor` = the last row's `id` as a decimal
string, `id < cursor` for the next page; `limit` 1–100 (default 50).
**Alternatives considered**: offset (the log grows at the head while paging → duplicates/skips);
keyset on `(ts, id)` with a microsecond codec (duplicates the memory-list codec; a cursor-row
`ts` lookup would also be a cross-tenant oracle unless re-scoped).
**Rationale**: `id` is `GENERATED ALWAYS AS IDENTITY` (unique, monotonic) so the keyset is exact
with a trivial, strictly-validated cursor; consistent with the memories list (keyset +
`nextCursor`). Display order equals insertion order.
**Reversible**: Yes — the cursor is documented as opaque; its encoding can change.

### Decision: Staging and dashboard lists are capped, not paginated

**Choice**: staging `limit` 1–50 sessions (default 20) + `truncated`; at most 100 items per
session + `itemsTruncated` and the real `itemCount`. Dashboard returns aggregates only.
**Alternatives considered**: a cursor per session list — no evidence of need at pilot scale.
**Rationale**: same "limit + truncated" shape as the review queue and quarantine lists.
**Reversible**: Yes (adding a cursor later is additive).

### Decision: Two partial indexes on access_log (migration 0011)

**Choice**: `migrations/0011_access_log_activity_indexes.sql` (idempotent):
`ix_audit_project_activity ON access_log (project_id, id DESC) WHERE action <> 'read'` for the
project branch and `ix_audit_job_activity ON access_log (id DESC) WHERE project_id IS NULL AND
actor_kind = 'system' AND action = 'admin'` for the job branch. Other tables rely on existing
indexes (`ix_memory_proj_status_type`, `ix_quarantine_list`/`ix_quarantine_project`,
`ux_session_open`, `ix_item_session`).
**Rationale**: verify round 1 (security MEDIUM): `access_log` grows with every read; the keyset
`ORDER BY id DESC LIMIT n+1` per branch must not scan it. Partial indexes skip read rows.
**Reversible**: Yes — `DROP INDEX`; no data is changed.

### Decision: Reads are excluded from the timeline; no live polling on the new screens

**Choice**: Actividad lists state-changing events only (`access_log.action <> 'read'`); the three
screens refresh with an explicit "Actualizar" button, never with `useAsync(…, refreshMs)`.
**Alternatives considered**: showing reads (every web page load is a `read` row — the timeline
would be noise and would include the viewer's own `activity.list` rows); 5 s polling like the
queue (one audit row per poll, and a moving head would reset "Cargar más").
**Rationale**: the proposal lists only write/lifecycle events; avoids audit-log self-inflation.
**Reversible**: Yes.

### Decision: Reserved sessions (`restore/`, `web/`) are excluded from Área de preparación and from label counts

**Choice**: `NOT starts_with(ss.branch, 'restore/') AND NOT starts_with(ss.branch, 'web/')`
(same prefixes as `isReservedBranch`; `starts_with`, not `LIKE`, precedent 0008).
**Alternatives considered**: labelling them in the list.
**Rationale**: they are server-owned single-item sessions already visible through Cuarentena and
Memoria; the view is "what agents proposed per branch". For metrics, a `restore/` item is the
restore label itself (counted once from `quarantine`), and a `web/` item is a human-authored
direct write, not a judge label.
**Reversible**: Yes (a filter can be added).

### Decision: Staging titles are PII-masked at read time

**Choice**: every `staging_item.title` returned by these endpoints goes through the existing
`maskPii(title).text` (`src/security/piiMask.ts`; titles ≤120 chars, idempotent on already masked
text).
**Alternatives considered**: returning raw titles.
**Rationale**: items of an **open** session have not been through promotion yet, so only the
capture-time secret scan has run (PII masking happens at promotion, S3/S4). The review queue never
shows un-masked titles; this keeps that guarantee. Bodies/summaries are never returned.
**Reversible**: Yes.

### Decision: People are rendered by display name only

**Choice**: actor/opener names are `app_user.display_name` joined by `idp_subject`; never the
email, idp subject, app_user id, CI repository identity or job trigger.
**Alternatives considered**: `COALESCE(display_name, email, author_identity)` as in the queue.
**Rationale**: SEC-L3 rule already applied to memory detail/revisions (C5) — the stricter one.
**Reversible**: Yes.

## Data Flow

    Web screen ──useAsync──▶ api/client.ts ──GET /api/v1/projects/:id/{dashboard|activity|staging}
                                                     │
               noStore → apiAuth (Gate 1) → makeProjectAdmin (Gate 2: project_admin, else 404)
                                                     │
                         insightsRoutes: strict zod (400) → InsightsRepository (SQL, project-scoped)
                                                     │                 │
                                    insightsMapping (pure)      memory / staging_* / quarantine /
                                                     │           access_log / app_user / repo
                         auditLogger.recordApi(actor, project, 'dashboard.read' | 'activity.list' | 'staging.list')
                                                     │
                                                  200 JSON (camelCase, ISO-8601)

### Data sources and SQL per view

All statements bind `$1 = project_id`. `W = 30` days (constant `WINDOW_DAYS`, bound as
`make_interval(days => $2)`), returned as `windowDays` so the UI never hard-codes it.

**Inicio — `getDashboard`** (6 statements run sequentially so one call never bursts six pool connections):

1. Memories — `SELECT status, type, count(*)::int FROM memory WHERE project_id = $1 GROUP BY status, type`
   → `byStatus` (all four statuses, zero-filled) and `activeByType` (status `active` only, zero-filled).
2. Queue — `SELECT count(*) FILTER (WHERE NOT si.mandatory_review), count(*) FILTER (WHERE si.mandatory_review)
   FROM staging_item si JOIN staging_session ss ON ss.id = si.session_id WHERE ss.project_id = $1 AND ${QUEUED_PREDICATE}`
   → `uncertain`, `mandatory`, `pending = uncertain + mandatory` (identical to the queue badge).
3. Quarantine — `SELECT criterion, count(*)::int FROM quarantine WHERE project_id = $1 AND restored_at IS NULL GROUP BY criterion`
   → `active` (all rows, incl. a legacy `NULL` criterion) and `byCriterion` (zero-filled).
4. Judge outcomes — over staging items of **agent sessions finalized by a promotion run inside the
   window** (`ss.promoted_at >= now() - W`, `si.judge_state <> 'pending'`, non-reserved branch):

   ```sql
   SELECT
     count(*) FILTER (WHERE si.judge_state = 'accepted')                                   AS accepted,
     count(*) FILTER (WHERE si.judge_state = 'uncertain' AND NOT ne.not_evaluated)          AS uncertain,
     count(*) FILTER (WHERE si.judge_state = 'rejected' AND jr.judge_rejected)              AS rejected,
     count(*) FILTER (WHERE si.judge_state = 'rejected' AND NOT jr.judge_rejected)          AS pipeline_blocked,
     count(*) FILTER (WHERE si.judge_state = 'uncertain' AND ne.not_evaluated)              AS not_evaluated,
     count(*) FILTER (WHERE si.judge_state = 'accepted' AND si.promoted_at IS NOT NULL
                        AND si.reviewed_at IS NULL)                                         AS auto_applied,
     count(*) FILTER (WHERE si.judge_state = 'rejected' AND jr.judge_rejected AND rq.id IS NULL) AS judge_rejected_unrestored
   FROM staging_item si
   JOIN staging_session ss ON ss.id = si.session_id
   LEFT JOIN quarantine rq ON rq.origin_item_id = si.id AND rq.project_id = ss.project_id
                          AND rq.restored_at IS NOT NULL
   CROSS JOIN LATERAL (SELECT si.judge_criterion IN ('duplication','specificity','security_second_layer')
                              AS judge_rejected) jr
   CROSS JOIN LATERAL (SELECT (si.judge_criterion = 'stale_target'
                               OR si.judge_reason IN ('judge_unavailable','judge_context_unavailable'))
                              AS not_evaluated) ne
   WHERE ss.project_id = $1 AND ss.promoted_at >= now() - make_interval(days => $2)
     AND si.judge_state <> 'pending'
     AND NOT starts_with(ss.branch, 'restore/') AND NOT starts_with(ss.branch, 'web/')
   ```
   (`COALESCE(…, false)` around both lateral booleans so a `NULL` criterion/reason is `false`.)
5. Review labels — window on **label time** `si.reviewed_at >= now() - W`, same project/branch
   filters, `si.review_decision IS NOT NULL`, and the evaluated-by-judge filter
   (`judge_state IN ('accepted','uncertain') AND NOT not_evaluated`):
   `uncertain_approved`, `uncertain_rejected`, `accepted_approved`, `accepted_rejected`.
6. Restore labels — `SELECT criterion, count(*)::int FROM quarantine WHERE project_id = $1
   AND restored_at >= now() - make_interval(days => $2) GROUP BY criterion`.

**Actividad — `listActivity`** (one statement; `$2 = category | NULL`, `$3 = cursor id | NULL`
as `::bigint`, `$4 = limit + 1`):

```sql
WITH page AS (
  ( SELECT al.id, al.ts, al.actor_kind, al.action, al.actor_identity, al.memory_id, al.session_id, al.detail,
           NULL::int AS job_count
    FROM access_log al
    WHERE al.project_id = $1 AND al.action <> 'read'
      AND ($3::bigint IS NULL OR al.id < $3::bigint)
      AND ($2::text IS NULL OR $2::text = CASE
            WHEN al.action = 'stage'                        THEN 'staging'
            WHEN al.actor_kind = 'ci'                       THEN 'promotion'
            WHEN starts_with(al.detail->>'api', 'review_queue.') THEN 'review'
            WHEN al.detail->>'api' = 'quarantine.restore'        THEN 'quarantine'
            WHEN starts_with(al.detail->>'api', 'memory.')       THEN 'memory'
            ELSE 'other' END)
    ORDER BY al.id DESC LIMIT $4 )
  UNION ALL
  ( SELECT al.id, al.ts, al.actor_kind, al.action, al.actor_identity, NULL, NULL, al.detail,
           CASE WHEN jsonb_typeof(al.detail->'detail'->$1::text) = 'number'
                THEN (al.detail->'detail'->>$1::text)::int END
    FROM access_log al
    WHERE al.project_id IS NULL AND al.actor_kind = 'system' AND al.action = 'admin'
      AND (al.detail->'detail') ? $1::text
      AND ($2::text IS NULL OR $2::text = 'jobs')
      AND ($3::bigint IS NULL OR al.id < $3::bigint)
    ORDER BY al.id DESC LIMIT $4 )
)
SELECT p.id::text, p.ts, p.actor_kind, p.action, p.detail_subset…, p.job_count,
       u.display_name AS actor_name,
       ss.branch AS session_branch,
       m.type AS m_type, m.title AS m_title,
       si.type AS i_type, si.title AS i_title,
       q.type AS q_type, q.title AS q_title
FROM page p
LEFT JOIN app_user u        ON p.actor_kind = 'user' AND u.idp_subject = p.actor_identity
LEFT JOIN staging_session ss ON ss.id = p.session_id AND ss.project_id = $1
LEFT JOIN memory m          ON m.id = p.memory_id AND m.project_id = $1
LEFT JOIN LATERAL (SELECT s2.type, s2.title FROM staging_item s2
                   JOIN staging_session ss2 ON ss2.id = s2.session_id AND ss2.project_id = $1
                   WHERE s2.id = CASE WHEN p.detail->>'itemId' ~ '^[0-9a-f-]{36}$'
                                      THEN (p.detail->>'itemId')::uuid END) si ON true
LEFT JOIN quarantine q      ON q.project_id = $1
                           AND q.id = CASE WHEN p.detail->>'quarantineId' ~ '^[0-9a-f-]{36}$'
                                           THEN (p.detail->>'quarantineId')::uuid END
ORDER BY p.id DESC LIMIT $4
```

- `query_hash`, `actor_identity`, `session_id`, `mergeSha`, `userId`, `repoId` are **never
  projected** to the DTO: `detail_subset` extracts only the allow-listed keys below, each with a
  `jsonb_typeof` guard (a malformed value becomes `NULL`, never a cast error/500).
- Every target join re-asserts `project_id = $1`, so an id of another project inside `detail`
  never resolves (target = `null`).
- Job rows: `recordJob` writes `project_id NULL` with per-project counts in `detail.detail`;
  a job appears only when it touched this project, with this project's count only.
- Branches use their own `ORDER BY … LIMIT` so each can use an index (`ix_audit_project` covers
  `project_id IS NULL` too); the outer limit keeps `limit + 1` rows to compute `nextCursor`.

**Área de preparación — `listStaging`** (2 statements; `$2 = 'open' | 'closed'`, `$3 = limit + 1`):

1. Sessions: `staging_session ss JOIN repo r ON r.id = ss.repo_id AND r.project_id = ss.project_id
   LEFT JOIN app_user u ON u.idp_subject = ss.opened_by`, non-reserved branch,
   `open` → `ss.status = 'open'`; `closed` → `ss.status <> 'open' AND COALESCE(ss.promoted_at,
   ss.last_activity_at) >= now() - interval '7 days'` (abandon sets `last_activity_at`; finalize sets
   `promoted_at`). Columns: id, repo id, slug, else `remote_url` with userinfo stripped, as label, branch, status,
   pr_number, `u.display_name`, created_at, last_activity_at, expires_at, `closed_at`
   (`NULL` when open), `(SELECT count(*) FROM staging_item WHERE session_id = ss.id)` as item_count.
   Order: `CASE WHEN open THEN last_activity_at ELSE closed_at END DESC, ss.id DESC`.
2. Items of the returned sessions: `WHERE ss.project_id = $1 AND si.session_id = ANY($2::text[])`,
   `row_number() OVER (PARTITION BY si.session_id ORDER BY si.created_at DESC, si.id DESC) <= 100`.
   Columns: id, op, type, title, judge_state, judge_criterion, mandatory_review, created_at and
   `state`:
   ```sql
   CASE WHEN si.promoted_at IS NOT NULL            THEN 'applied'
        WHEN si.review_decision = 'rejected'       THEN 'review_rejected'
        WHEN si.judge_state = 'rejected'           THEN 'quarantined'
        WHEN (${QUEUED_PREDICATE})                 THEN 'queued'
        ELSE 'staged' END
   ```
   Titles are passed through `maskPii` in TypeScript. No summary/body/fields/author are selected.

### Metric definitions (live, from stored labels)

Population: staging items from **agent** sessions (non-reserved branch) that the judge actually
evaluated — `judge_state ∈ {accepted, uncertain, rejected}`, excluding `stale_target` (routing
rule R1, the judge is not consulted) and fail-closed `judge_unavailable` /
`judge_context_unavailable` (no evaluation at all; same set as `isEvaluationUnavailable`).
Judge "held back" (positive) = `uncertain` (includes R6: accepted below the 0.80 threshold, which
is persisted as `uncertain`/`confidence`) or `rejected` with a judge criterion
(`duplication`, `specificity`, `security_second_layer`).

| Label source (window = label time, 30 days) | Judge said | Human said | Class |
|---|---|---|---|
| `review_decision='approved'` on `judge_state='uncertain'` | held back | good | **FP** |
| `quarantine.criterion='judge'` with `restored_at` set | held back (rejected) | good | **FP** |
| `review_decision='rejected'` on `judge_state='uncertain'` | held back | bad | TP |
| `review_decision='approved'` on `judge_state='accepted'` (mandatory review, R7 / SEC M-1) | passed | good | TN |
| `review_decision='rejected'` on `judge_state='accepted'` (mandatory review) | passed | bad | **FN** |

- **FP rate** = (uncertainApproved + restoredFromJudge) / (uncertainApproved + restoredFromJudge + acceptedApproved) — "buenas retenidas / buenas etiquetadas".
- **FN rate** = acceptedRejected / (acceptedRejected + uncertainRejected) — "malas que pasan / malas etiquetadas".
- A rate is `null` (UI: "sin datos") when its denominator is 0. Counts and denominators are always returned.
- `review_decision`/`judge_state` survive approval/rejection (MARK_APPROVED/MARK_REJECTED never
  touch `judge_state`), and promoted/reviewed items are never deleted (only unpromoted items of an
  abandoned session are), so labels are durable. Restore labels live on the quarantine row and
  disappear when the purge job deletes it (60 days after quarantine).

**Measurable**: FP over everything the judge held back that a human later resolved (queue
decisions + restores); FN **only** for judge-accepted units that were forced into review — the
mandatory types/ops (`MANDATORY_REVIEW_TYPES`, supersede/deprecate, SEC M-1 target-type guard).

**Not measurable** (shown as "sin etiqueta" coverage, never folded into a rate):
- judge-accepted units auto-applied by R8 (`autoApplied`) — no human looked at them; a later
  retire does not record whether the judge was wrong;
- judge rejections never restored (`judgeRejectedNotRestored`) — silence is not agreement;
- pipeline blocks (secrets, injection, sanitize failure, DB duplicate at apply) — not judge
  decisions; restores of `pipeline` and `human_review` quarantines are shown as human
  corrections but excluded from the rates;
- the sample is biased toward critical types for FN and toward held-back units for FP; the UI
  states this next to the numbers.

Judge outcome distribution (separate from labels) uses evaluation time ≈ `staging_session.promoted_at`
(set once when the promotion run finalizes the session; there is no per-item judged-at column).

### Activity: action codes, Spanish labels and facts

| Row in `access_log` | `action` code | Spanish label (web `labels.ts`) | Category | Facts |
|---|---|---|---|---|
| `stage` + `detail.tool='remember'` | `staging.remember` | Propuesta registrada por un agente | staging | branch |
| `stage` + `detail.tool='discard_staged'` | `staging.discard` | Propuesta descartada por el agente | staging | branch |
| `promote` (ci) | `promotion.run` | Promoción tras el merge | promotion | branch, prNumber, applied, queued (= `uncertain`), quarantined |
| `delete` + `detail.event='closed_unmerged'` (ci) | `promotion.abandon` | PR cerrada sin merge: propuestas descartadas | promotion | branch, prNumber, discarded |
| `update` + `api='review_queue.approve'` | `review.approve` | Propuesta aprobada en revisión | review | — |
| `update` + `api='review_queue.reject'` | `review.reject` | Propuesta rechazada en revisión | review | — |
| `update` + `api='quarantine.restore'` | `quarantine.restore` | Restaurada desde cuarentena | quarantine | outcome |
| `update` + `api='memory.create'` | `memory.create` | Unidad creada desde la web | memory | outcome |
| `update` + `api='memory.amend'` | `memory.amend` | Unidad modificada desde la web | memory | outcome |
| `update` + `api='memory.confirm'` | `memory.confirm` | Unidad revalidada | memory | — |
| `update` + `api='memory.retire'` | `memory.retire` | Unidad retirada | memory | — |
| `update` + `api='memory.retire_by_pr'` | `memory.retire_by_pr` | Unidades retiradas por PR | memory | originPr, count (= `resultCount`) |
| `admin` (system) + `job='quarantine-purge'` | `job.quarantine_purge` | Purga de cuarentena | jobs | count (this project) |
| `admin` (system) + `job='revalidation-sweep'` | `job.revalidation_sweep` | Barrido de revalidación | jobs | count |
| `admin` (system) + `job='web-session-reaper'` | `job.web_session_reaper` | Limpieza de sesiones web | jobs | count |
| any other non-read row | `other` | Otra acción registrada | (none) | — |

Per-item judge outcomes are **not** audit events; the timeline shows them aggregated on
`promotion.run` (applied / a revisión / en cuarentena) and per item in Área de preparación.

Actor rendering: `ci` → `{kind:'ci', name:null}` ("CI"); `system` → `{kind:'system'}` ("Sistema");
`user` with `detail.tool` (MCP) → `{kind:'agent', name}` ("Agente" or "Agente · {name}");
`user` with `detail.api` → `{kind:'user', name}` (name, or "Usuario sin nombre"); `agent` enum →
`agent`. `name` = `app_user.display_name` or `null`.

Target: first resolvable of memory (`access_log.memory_id`) → staging item (`detail.itemId`) →
quarantine (`detail.quarantineId`), each re-scoped to the project; `title` from staging is
`maskPii`-ed; `null` when deleted/purged/foreign ("—" in the UI).

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `InsightsRepository` / `PgInsightsRepository` | interface / class | `src/db/insightsRepository.ts` | `src/http/api/insightsRoutes.ts`, `src/http/api/types.ts`, `src/mcp/context.ts`, `src/index.ts` |
| `judgeRates`, `toActivityEvent`, `parseActivityCursor`, `WINDOW_DAYS` | func / const | `src/db/insightsMapping.ts` | `src/db/insightsRepository.ts`, `src/http/api/insightsRoutes.ts` |
| `DashboardDto` | type | `src/http/api/types.ts` | `src/db/insightsRepository.ts`, `packages/web/src/api/types.ts` (mirror) |
| `ActivityListDto`, `ActivityEventDto`, `ActivityAction`, `ActivityCategory`, `ActorKind` | type | `src/http/api/types.ts` | `src/db/insightsMapping.ts`, `src/db/insightsRepository.ts`, `packages/web/src/api/types.ts` |
| `StagingOverviewDto`, `StagingSessionDto`, `StagingOverviewItemDto`, `StagingItemState` | type | `src/http/api/types.ts` | `src/db/insightsRepository.ts`, `packages/web/src/api/types.ts` |
| `ApiAction` += `'dashboard.read' \| 'activity.list' \| 'staging.list'` | type | `src/mcp/context.ts` | `src/http/api/insightsRoutes.ts` |
| `makeInsightsRoutes` | func | `src/http/api/insightsRoutes.ts` | `src/http/api/router.ts` |
| `GET /api/v1/projects/:projectId/dashboard` | endpoint | `src/http/api/insightsRoutes.ts` | `packages/web/src/api/client.ts` |
| `GET /api/v1/projects/:projectId/activity` | endpoint | `src/http/api/insightsRoutes.ts` | `packages/web/src/api/client.ts` |
| `GET /api/v1/projects/:projectId/staging` | endpoint | `src/http/api/insightsRoutes.ts` | `packages/web/src/api/client.ts` |
| `Route` += `home`, `activity`, `staging` | type | `packages/web/src/lib/hashRoute.ts` | `packages/web/src/App.tsx`, `packages/web/src/components/Sidebar.tsx` |
| `StatBar` | component | `packages/web/src/components/StatBar.tsx` | `packages/web/src/screens/HomeScreen.tsx` |

### Endpoint contracts

All: `project_admin` only (after `makeProjectAdmin`); contributor, viewer, non-member, foreign,
nonexistent or malformed project id → identical `404 {"error":"Not found"}` and no audit row;
unknown or repeated query keys / out-of-range values → `400 {"error":"Invalid request"}` (no
echo); `Cache-Control: no-store` (router-level); audit **after** success via `recordApi`
(`access_log.action = 'read'`, `detail.api` = the action name, ids/counters only).

| Endpoint | Query (zod, `.strict()`) | Response | Audit action / detail |
|---|---|---|---|
| `GET …/dashboard` | none (`z.object({}).strict()`) | `DashboardDto` | `dashboard.read` / — |
| `GET …/activity` | `category?: enum('staging','promotion','review','quarantine','memory','jobs')`; `cursor?: string` matching `^[1-9][0-9]{0,18}$` and ≤ 9223372036854775807; `limit: z.coerce.number().int().min(1).max(100).default(50)` | `ActivityListDto` | `activity.list` / `{ resultCount }` |
| `GET …/staging` | `status: enum('open','closed').default('open')`; `limit: z.coerce.number().int().min(1).max(50).default(20)` | `StagingOverviewDto` | `staging.list` / `{ status, resultCount }` (both keys already allow-listed) |

```ts
// src/http/api/types.ts (additions; JSON camelCase, ISO-8601 timestamps)
export interface RateDto { count: number; of: number; rate: number | null }

export interface DashboardDto {
  generatedAt: string;
  windowDays: number; // 30
  memories: {
    total: number;
    byStatus: Record<MemoryStatus, number>;
    activeByType: Record<MemoryType, number>;
  };
  queue: { pending: number; uncertain: number; mandatory: number };
  quarantine: { active: number; byCriterion: Record<QuarantineCriterion, number> };
  judge: {
    outcomes: { accepted: number; uncertain: number; rejected: number; pipelineBlocked: number; notEvaluated: number };
    labels: {
      uncertainApproved: number; uncertainRejected: number;
      acceptedApproved: number; acceptedRejected: number;
      restoredFromJudge: number;
    };
    /** Human corrections outside the judge metrics. */
    restoredOther: { pipeline: number; humanReview: number };
    unlabeled: { autoApplied: number; judgeRejectedNotRestored: number };
    falsePositive: RateDto;
    falseNegative: RateDto;
  };
}

export type ActivityCategory = 'staging' | 'promotion' | 'review' | 'quarantine' | 'memory' | 'jobs';
export type ActivityAction =
  | 'staging.remember' | 'staging.discard'
  | 'promotion.run' | 'promotion.abandon'
  | 'review.approve' | 'review.reject'
  | 'quarantine.restore'
  | 'memory.create' | 'memory.amend' | 'memory.confirm' | 'memory.retire' | 'memory.retire_by_pr'
  | 'job.quarantine_purge' | 'job.revalidation_sweep' | 'job.web_session_reaper'
  | 'other';
export type ActorKind = 'user' | 'agent' | 'ci' | 'system';

export interface ActivityEventDto {
  id: string;
  at: string;
  action: ActivityAction;
  actor: { kind: ActorKind; name: string | null };
  target: { kind: 'memory' | 'staging_item' | 'quarantine'; type: MemoryType; title: string } | null;
  facts: {
    branch?: string; prNumber?: number;
    applied?: number; queued?: number; quarantined?: number; discarded?: number;
    count?: number; originPr?: number;
    outcome?: 'applied' | 'queued' | 'quarantined';
  };
}
export interface ActivityListDto { items: ActivityEventDto[]; nextCursor: string | null }

export type StagingItemState = 'staged' | 'queued' | 'applied' | 'quarantined' | 'review_rejected';
export interface StagingOverviewItemDto {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  /** PII-masked. */
  title: string;
  judgeState: 'pending' | 'accepted' | 'uncertain' | 'rejected';
  criterion: DecisionCriterion | null;
  mandatoryReview: boolean;
  state: StagingItemState;
  createdAt: string;
}
export interface StagingSessionDto {
  id: string;
  repo: { id: string; label: string };
  branch: string;
  status: 'open' | 'validating' | 'promoted' | 'partially_promoted' | 'rejected' | 'abandoned';
  prNumber: number | null;
  /** Display name only. */
  openedBy: string | null;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string | null;
  closedAt: string | null;
  itemCount: number;
  items: StagingOverviewItemDto[];
  itemsTruncated: boolean;
}
export interface StagingOverviewDto { sessions: StagingSessionDto[]; truncated: boolean }
```

```ts
// src/db/insightsRepository.ts
export interface InsightsRepository {
  getDashboard(projectId: string): Promise<DashboardDto>;
  listActivity(
    projectId: string,
    q: { category: ActivityCategory | null; cursor: string | null; limit: number },
  ): Promise<ActivityListDto>;
  listStaging(
    projectId: string,
    q: { status: 'open' | 'closed'; limit: number },
  ): Promise<StagingOverviewDto>;
}
```

### Web screens

- **Inicio** (`#/home`, `HomeScreen.tsx`): cards — *Memoria* (`StatBar` list by status; by type
  for active), *Pendiente* (queue pending/uncertain/mandatory and quarantine active by criterion,
  with buttons to Cola de revisión / Cuarentena via `navigate`), *Decisiones del Juez (últimos 30
  días)* (`StatBar` for the five outcome buckets), *Correcciones humanas* (the five label counts +
  restoredOther), *Indicadores del Juez* (FP and FN as `formatPercent(rate)` + "n de m", or "sin
  datos"; the two definitions and the coverage line "Sin etiqueta: X aplicadas automáticamente, Y
  rechazos no restaurados" always visible as text; a note that `docs/demo/metricas.md` has the
  synthetic counterpart).
- **Actividad** (`#/activity`, `ActivityScreen.tsx`): `FilterBar` (Todas + 6 categories, reset
  pages on change), table (hidden caption; Fecha `formatDateTime`, Actor, Acción, Objeto
  `TypeChip` + title or "—", Detalle = `activityFactsText(facts)`), "Cargar más" when `nextCursor`
  (MemoryScreen pattern), "Actualizar" button.
- **Área de preparación** (`#/staging`, `StagingScreen.tsx`): `FilterBar` Abiertas / Cerradas
  (7 días); one card per session (repo label · branch · PR, status `Chip`, opened by, last
  activity, expiry/closed date, item count, truncation note) with an items table (type chip,
  title, op label, Juez state label + criterion short label, state chip).
- All three render `NoAccess` without calling the API when `role !== 'project_admin'`; text
  only; `StatBar` is decorative (`aria-hidden` track) with the number as visible text, width via
  CSSOM `style={{ width }}` exactly like `ConfidenceBar` (CSP-safe), CSS classes appended to
  `styles.css` using existing tokens.
- Sidebar order: Inicio, Cola de revisión, Área de preparación, Memoria del proyecto, Cuarentena,
  Actividad, Administración. The default route for an empty/unknown hash is Inicio (`#/home`).

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/db/insightsRepository.ts` | Create | `InsightsRepository` + `PgInsightsRepository`: dashboard (6 aggregates), activity (keyset UNION + project-scoped target joins), staging (sessions + capped items); `maskPii` on staging titles |
| `src/db/insightsMapping.ts` | Create | Pure: `WINDOW_DAYS`, `judgeRates`, `toActivityEvent` (raw row → action code, actor, target, allow-listed facts), `parseActivityCursor` |
| `src/http/api/insightsRoutes.ts` | Create | `GET /dashboard`, `/activity`, `/staging`: strict zod, repository call, audit after success |
| `src/http/api/types.ts` | Modify | Add DTO types above; `insightsRepository: InsightsRepository` in `ApiRouterDeps` |
| `src/http/api/router.ts` | Modify | Mount `makeInsightsRoutes(deps)` in the `projectAdmin` chain; header comment |
| `src/mcp/context.ts` | Modify | `ApiAction` += 3 read actions; `AppServices.insightsRepository` (required because `createApp` passes `AppServices` to `makeApiRouter`) |
| `src/index.ts` | Modify | `insightsRepository: new PgInsightsRepository(pool)` in `services` |
| `tests/db/insightsMapping.test.ts` | Create | Unit: rates/denominators/null, FP includes judge restores, action/actor mapping table, unknown → `other`, facts allow-list and type guards, cursor bounds |
| `tests/http/api/insights.test.ts` | Create | Supertest: admin 200 + audit rows; uniform 404 (contributor, viewer, foreign, random, malformed id) with no audit; 400 matrix; no-store; DTO never carries hash/identity |
| `tests/http/api/helpers.ts` | Modify | Add `FakeInsightsRepository` (records calls, scripted DTOs — same place as `FakeAdminSummaryRepository`) and wire it into `makeApiTestApp` deps and the kit |
| `tests/auth/fakes.ts` | Modify | Add `insightsRepository` to the `AppServices` fake |
| `tests/db/insightsRepository.integration.test.ts` | Create | DB-gated: fixture with every label combination, exclusions, windows, activity paging/scoping/jobs, staging states/window/caps/PII |
| `packages/web/src/api/types.ts` | Modify | Mirror the new DTOs |
| `packages/web/src/api/client.ts` | Modify | `getDashboard`, `listActivity(p, {category?, cursor?, limit?})`, `listStaging(p, {status, limit?})` |
| `packages/web/src/api/client.test.ts` | Modify | URLs, encoded project segment, dropped empty query values |
| `packages/web/src/lib/hashRoute.ts` | Modify | Routes `home`, `activity`, `staging` (`#/home`, `#/activity`, `#/staging`) |
| `packages/web/src/lib/hashRoute.test.ts` | Modify | Parse/build round-trip for the three routes; extra segments fall back |
| `packages/web/src/lib/labels.ts` | Modify | `Record<…>` maps: activity action, category, actor kind, staging item state, session status, judge state; metric definition texts; quarantine footer → "falsos positivos" |
| `packages/web/src/lib/insights.ts` | Create | Pure: `formatPercent`, `barPercent(value, max)`, `activityFactsText(facts)`, `actorText(actor)` |
| `packages/web/src/lib/insights.test.ts` | Create | Unit tests for the helpers (null rate, zero max, facts ordering, actor fallbacks) |
| `packages/web/src/components/StatBar.tsx` | Create | Label + visible number + decorative proportional bar |
| `packages/web/src/components/Sidebar.tsx` | Modify | Three NAV entries + `sectionOf` cases |
| `packages/web/src/App.tsx` | Modify | Three `Screen` switch cases |
| `packages/web/src/screens/HomeScreen.tsx` | Create | Inicio |
| `packages/web/src/screens/ActivityScreen.tsx` | Create | Actividad |
| `packages/web/src/screens/StagingScreen.tsx` | Create | Área de preparación |
| `packages/web/src/styles.css` | Modify | Append a delimited `/* insights */` section (`.stat-bar*`, `.kpi*`, `.session-card*`) using existing tokens |
| `scripts/screenshots.ts` | Modify | Capture `#/home`, `#/activity`, `#/staging` (success criterion "screenshots updated") |
| `docs/demo/INSTRUCTIVO.md` | Modify | Short section: the three views and the live FP/FN definitions (proposal risk mitigation) |

## New Modules

None.

## Test Strategy

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| `src/db/insightsMapping.ts` | unit | FP = (ua+rj)/(ua+rj+aa); FN = ar/(ar+ur); zero denominators → `null`; every row kind in the action table maps to its code; unknown api/job → `other`; MCP user row → actor `agent`; ci/system names always `null`; non-number fact values dropped; unknown detail keys never copied; cursor `0`, `-1`, `01`, 20 digits, > int8 max → invalid | No DB |
| `src/http/api/insightsRoutes.ts` | unit (supertest) | 200 for project_admin on the three paths; 404 byte-identical for contributor/viewer/foreign/random/malformed id and zero new `access_log` rows; 400 for `?x=1`, repeated `category`, `category=other`, `limit=0/101`, `status=all`, bad cursor; audit row `detail.api` = `dashboard.read`/`activity.list`/`staging.list`, `action='read'`, no content; `Cache-Control: no-store` | `makeApiTestApp` + `FakeInsightsRepository`; `InMemoryAuthRepository` exposes audit rows |
| `PgInsightsRepository.getDashboard` | integration (DB) | Fixture: 2 uncertain-approved, 2 uncertain-rejected, 5 accepted-approved, 1 accepted-rejected, 1 judge restore, 1 pipeline restore → FP 3/8, FN 1/3; excluded: `restore/` and `web/` items, `stale_target`, `judge_unavailable`, `pending`; labels with `reviewed_at` 31 days ago excluded; outcome buckets incl. pipeline-blocked (`rejected`, criterion `NULL`) and dedup-at-apply (`rejected`, `confidence`); queue counts equal `countQueue`; other project's rows never counted | `DATABASE_URL ? describe : describe.skip`; numbers asserted against hand-written SQL in the test |
| `PgInsightsRepository.listActivity` | integration (DB) | Reads excluded; newest first; cursor pages disjoint and complete; category filter; job row with this project's key included with its count, job without it excluded; foreign `memoryId`/`itemId` in detail → `target null`; discarded item → `target null`; serialized result never contains the stored `query_hash`, `actor_identity`, email or `mergeSha` | Rows inserted via `insertAccessLog` and `RdsAuditLogger` |
| `PgInsightsRepository.listStaging` | integration (DB) | open vs closed (6 vs 8 days ago); reserved branches excluded; each `state` value; title with an email returned as `[EMAIL]`; 101 items → 100 + `itemsTruncated`, `itemCount=101`; `limit` + `truncated`; opener display name only | |
| Web helpers / client / routes | unit | `formatPercent(null)` → "sin datos"; `barPercent(0,0)` = 0; facts text; client URLs; hash routes | Root vitest, node env |
| Screens | manual + screenshots | Seed + `pnpm demo` data render; viewer sees NoAccess and no 404 in console | `pnpm screenshots` |

## Risks and follow-ups

- **Shared-file edits beyond the orchestrator's list**: `src/mcp/context.ts` (ApiAction union,
  AppServices), `tests/http/api/helpers.ts`, `tests/auth/fakes.ts`, `styles.css`,
  `hashRoute.test.ts`, `client.test.ts`, `scripts/screenshots.ts`, `INSTRUCTIVO.md` are needed.
  All are one-line/append-only additions; `ci-and-security-followups` may touch `context.ts`
  (AuditLogger) and `demo-ux-polish` touches `styles.css` — merge by appending.
- **Activity query cost** is bounded by the 0011 partial indexes (project branch and job branch).
- **Global id exposure**: `access_log.id` (event id and cursor) reveals platform-wide audit volume
  through gaps. Accepted for the single-tenant pilot (low); an HMAC'd cursor is the fix if needed.
- **Metric misreading**: definitions are rendered next to the numbers; the quarantine footer is
  corrected to "falsos positivos" to match the quarantine spec and `metricas.md` (it currently
  says "falsos negativos").
- **Label durability**: restore labels vanish when quarantine rows are purged (60 days); the 30-day
  window stays inside retention.
