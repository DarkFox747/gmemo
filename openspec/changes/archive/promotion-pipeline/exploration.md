# Exploration — promotion-pipeline

schema: exploration-synthesis-v1
change: promotion-pipeline
date: 2026-07-30
agents: 2 (apply-to-main seams · endpoint/OIDC/judge seams)
status: COMPLETE

## Headline
The promotion pipeline splits cleanly into a **locally implementable + testable core** and a
**genuinely AWS-infra-deferred shell**. Both explore agents independently proposed the same split.
Schema is fully ready (migration 0004 closed every gap). `memoryRepository` is **read-only today** —
the entire write-to-main path is greenfield.

## A) Apply-to-main path (agent A)
- **`memoryRepository` has ZERO writes** (only recall/getMemoryByHandle/getContextRecords). A new
  write surface is needed — best as a new `src/db/promotionRepository.ts` mirroring `stagingRepository.ts`.
- **Op → writes** (from 0002 schema):
  - `add` → INSERT memory (current_revision=1, status=active) + INSERT memory_revision(rev=1, op='add', promoted_from_item).
  - `amend` → SELECT target FOR UPDATE; assert `current_revision == target_revision`; UPDATE memory (content, current_revision++) + INSERT memory_revision(rev=current+1, op='amend').
  - `supersede` → INSERT new memory + revision; UPDATE old target status='superseded'; INSERT memory_relation(supersedes, source='judge') `ON CONFLICT DO NOTHING`.
  - `deprecate` → UPDATE target status='deprecated', current_revision++ + INSERT memory_revision(op='deprecate').
- **`content_tsv` is `GENERATED ALWAYS`** — must NEVER appear in any INSERT/UPDATE column list (Postgres rejects it).
- **Dedup**: `UNIQUE(project_id, content_hash)` → `add` of existing content = `INSERT ... ON CONFLICT DO NOTHING RETURNING id` + re-select → set `promoted_memory_id` to the existing id (idempotent no-op).
- **Idempotency guard**: every apply `WHERE ... AND promoted_at IS NULL`; set `promoted_at=now(), promoted_memory_id=$id` on success (first-writer-wins).
- **Terminal state**: after processing a session → `promoted` / `rejected` / `partially_promoted`; set `staging_session.promoted_at`.
- **Concurrency risk**: `staging_item.target_revision` captured at `remember()` time; if `memory.current_revision` moved by apply time → conflict. Use `SELECT FOR UPDATE` + assert equality.

## B) Endpoint / OIDC / Judge seams (agent B)
- **`POST /mcp` is a one-line factory** in `src/http/app.ts` (`app.post('/mcp', makeMcpPostHandler(services))`). `POST /promote` is an identical one-liner with its own handler factory + service bag, before the terminal error handler.
- **Injectable-seam pattern is consistent**: interface + constructor injection + config-guarded dev stub. Replicate for two new seams:
  - **Judge**: `src/judge/judge.ts` (interface `evaluate(item) → 'accepted'|'rejected'|'uncertain'`) + `BedrockJudge` (real; catches ALL errors → `uncertain`) + `DeterministicJudge` stub (config verdict). **Fail-closed is mandated by docs/04: LLM down → uncertain, NEVER accepted.**
  - **OIDC auth for /promote** (NOT Cognito): `OidcVerifier` interface + `GithubOidcAuthenticator` + `DevOidcAuthenticator` stub. `PromotePrincipal` carries `repository` (org/repo) + `ref`, not clientId/scopes. Tenant resolved by repo slug from the OIDC claim (not `X-Git-Remote`).
- **Config guard**: reuse the exact 4-barrier pattern (`z.enum(['true','false']).transform`, NOT `z.coerce.boolean`; `superRefine` forbids stub/bypass in production). New env: `JUDGE_STUB`, `JUDGE_STUB_VERDICT`, `BEDROCK_MODEL_ID`, and an OIDC dev-bypass flag.
- **Sanitize step (per item, before judge)**: reuse existing `assertNoSecrets` (already fail-closed, category-only logging). Secrets in quarantine stored redacted + reason.
- **Verdict persisted before apply**: check `staging_item.judge_state` first; if already judged, reuse — re-runs never re-judge.

## Proposed local-vs-deferred split (both agents agree)
**LOCAL (this change — implementable + fully testable, no real AWS):**
- `POST /promote` route + `makePromoteHandler` factory.
- `OidcVerifier` seam + `DevOidcAuthenticator` stub + config guard (real JWKS verification deferred).
- `Judge` seam + `DeterministicJudge` stub + config guard (real Bedrock deferred).
- `PromotionRepository` apply path (4 ops → memory/memory_revision/memory_relation), dedup, `FOR UPDATE` concurrency, idempotency (`promoted_at`), quarantine write, session terminal state.
- `PromoteService.promote(sessionId)` orchestration: per item → sanitize (assertNoSecrets) → judge → apply/quarantine; conflict (stale target) → quarantine with reason (NO 3-way merge in pilot).
- Full unit + DB-gated integration + supertest tests.

**DEFERRED (AWS infra / follow-up):**
- Real `BedrockJudge` (VPC PrivateLink + IAM + model access).
- Real GitHub OIDC JWKS verification + API Gateway IAM authorizer config.
- GitHub Action YAML (PR-merge trigger, body construction).
- `machine_credential` provisioning for the Actions role.
- Quarantine sweep/retention job (the 1-vs-2-month decision).
- 3-way merge reconciliation + Web UI human-review queue for `uncertain`.

## Risks carried into design
- **Fail-closed judge**: BedrockJudge must catch ALL error levels → `uncertain`; the orchestrator must never default a caught error to `accepted`.
- **Prod bypass**: `JUDGE_STUB` + OIDC dev-bypass MUST use the same superRefine guard or they leave a prod hole.
- **RBAC single-lib**: /promote authz (machine_credential → repo) must go through the same RDS authz path, not a divergent one.
- **Tenant mapping**: /promote resolves tenant by repo slug (OIDC claim), a different input than `X-Git-Remote` — may need `findRepoByGithubSlug` (or reuse remote_url mapping).
- **Partial failure**: per-item transactions (partially_promoted) require compensation; single-txn is all-or-nothing. Design must pick (per-item is implied by the `partially_promoted` state).
- **Uncertain items**: no Web UI yet → left un-applied, session `partially_promoted`.

## Cross-cutting resolved
- `provenance` column on `memory` = `pr_reviewed` for the /promote path (vs `manual_ui`).
- `memory.origin_branch`/`origin_pr` populated from the promote request body.
- `memory_relation` UNIQUE(from,to,type) → supersede insert needs `ON CONFLICT DO NOTHING` for re-run safety.
