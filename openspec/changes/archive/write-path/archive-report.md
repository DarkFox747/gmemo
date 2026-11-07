# Archive Report — write-path (write-to-staging slice)

schema: archive-report-v1
change: write-path
status: CLOSED
verdict: PASS
archived_at: 2026-07-30

## Outcome
Agents can now PROPOSE memory. The three write tools — `remember`, `list_staged`,
`discard_staged` — write ONLY to a lazily-created staging session keyed `(project, repo,
branch)`; `recall` mixes the caller's own staged drafts as `source:"staged"` (first page only).
Nothing touches the authoritative `memory` table. Promotion to main remains OUT of scope
(a separate `promotion-pipeline` change).

## Pipeline
explore (2 agents) → proposal (inline) → specs ∥ design (architect) → tasks (inline) →
apply (7 batches A–G, 13 worker dispatches) → verify (security + reviewer + build-worker) →
remediation (1 worker: H1+M1+L1..L5) → archive (inline).

## What shipped
- Migration `0003_staging.sql` — `staging_session` (ULID PK, partial unique index one-open-per-key)
  + `staging_item` (NOT NULL title/summary, op↔target CHECK, budget CHECKs, `UNIQUE(session_id,content_hash)`).
- `StagingRepository` (`PgStagingRepository`): findOrCreateOpenSession (upsert+reselect+7d TTL),
  insertStagingItem (idempotent dedup), listStagingItems, discardStagingItem — all parameterized + tenant-scoped.
- 3 write tools + `registerWriteTools`; `remember` 8-step handler (fields policy → op/target →
  stale→uncertain → secret-scan → content_hash → session → insert).
- RBAC write-role enforcement (contributor/service_agent/project_admin; viewer denied) — landed
  atomically with the `ToolName` widening.
- `AuditLogger.recordWrite` — `remember` AND `discard_staged` audited (action='stage', hash-only).
- Inline fail-closed secret-scan (9 categories, category-only logging); per-type `fields` policy.
- `recall` staged-mix; `toStagedRecord`; ULID generator (no dep).

## Requirements
REQ-01..REQ-27 satisfied (REQ-20 satisfied via remediation H1; spec wording REQ-07 corrected to `{id,state}`).

## Security (audited, holds)
0 CRITICAL / 0 HIGH. RBAC atomic + viewer-denied; tenant isolation enforced at SQL layer;
all SQL parameterized; secret-scan before persist, fail-closed, never logs/stores the secret;
error opacity (4 codes, no enumeration); audit only after successful persist; `fields` size bounded
(ReDoS/DoS mitigated); ULID uses crypto randomness.

## Tests
285 passing (unit + handler), 49 DB-gated integration skipped without `DATABASE_URL`. Build + lint clean.

## Deferred → backlog (separate `promotion-pipeline` change)
- `POST /promote` + GitHub Action OIDC trigger; sanitize pipeline; Bedrock judge (3-state, fail-closed);
  quarantine table + retention decision (1 vs 2 months); schema gaps `promoted_at`/`promoted_memory_id`,
  `partially_promoted`; concurrency 3-way merge; Web UI uncertain queue.
- Also carried: helmet + express-rate-limit (need deps); pgvector; service-agent auth (fail-closed).

## Accepted trade-offs
- `recall` staged-mix is unranked and first-page-only (continuity, not authority) — YAGNI for the pilot.
- `content_hash` canonicalizes top-level keys only (not deep `fields` key order) — matches design; deep
  canonicalization deferred until dedup robustness is a real concern.

## Human follow-up (once)
Run the DB-gated integration suite against a live Postgres (`DATABASE_URL=… pnpm test -- --run`) to
exercise the migration constraints + repository race/dedup/scoping tests (no DB daemon in the build env).
