# Proposal — promotion-pipeline (local-testable vertical)

schema: proposal-v1
change: promotion-pipeline
status: PROPOSED
date: 2026-07-30

## Problem
Agents propose to staging, but **nothing reaches `memory`**. The loop is open: staged items never
become authoritative. `memoryRepository` is read-only; there is no apply path, no judge, no
`/promote` entry point.

## Chosen approach (scoping decision)
Ship the **entire locally-runnable + testable vertical** of the promotion pipeline in ONE change,
using injectable stubs for the two pieces that need real AWS. Concretely: a real `POST /promote`
endpoint you can `curl` under the dev-harness → an injectable OIDC authenticator (dev stub) →
`PromoteService.promote(sessionId)` orchestration → sanitize (reuse `assertNoSecrets`) → an
injectable **Judge** (deterministic stub) → a real **apply** that writes `memory` /
`memory_revision` / `memory_relation` idempotently → quarantine for rejects → session terminal
state. Everything is DB-backed and unit/integration tested with no real AWS.

The two pieces that genuinely need AWS — the **real Bedrock judge** and the **real GitHub-OIDC/API-
Gateway verification + GitHub Action** — are behind the SAME injectable-seam + 4-barrier config-guard
pattern already used for Cognito (`DevAuthenticator`). Their real implementations are DEFERRED; the
seams and stubs land now so the pilot is end-to-end demoable locally and the real impls drop in later
without touching the orchestration.

Rationale: this closes the memory loop locally (high value, demoable), reuses established patterns,
and keeps the AWS-coupled work isolated behind seams — consistent with the dev-harness philosophy.

## Scope

### IN scope (local vertical)
- **`PromotionRepository`** (`src/db/promotionRepository.ts`, mirrors `stagingRepository.ts`): the 4
  op→SQL applies (add/amend/supersede/deprecate) writing `memory` + `memory_revision` (+
  `memory_relation` for supersede), all tenant-scoped, parameterized, `content_tsv` never in a column
  list, `add` dedup via `ON CONFLICT (project_id, content_hash) DO NOTHING`, amend/supersede/deprecate
  gated by `SELECT ... FOR UPDATE` + `current_revision == target_revision` check; set
  `staging_item.promoted_at`/`promoted_memory_id`; write `quarantine` snapshot; set session terminal
  status (`promoted`/`rejected`/`partially_promoted`, `promoted_at`).
- **Judge seam**: `src/judge/judge.ts` (interface) + `DeterministicJudge` stub (config verdict) +
  a `BedrockJudge` skeleton that is FAIL-CLOSED (catches all errors → `uncertain`) but only selected
  when `JUDGE_STUB=false` (real Bedrock call itself may be a thin TODO — see deferred).
- **OIDC auth seam for `/promote`**: `OidcVerifier` interface + `DevOidcAuthenticator` stub +
  config-guarded selection; `PromotePrincipal` (repository + ref); tenant resolved by repo slug;
  authorization via the existing RDS authz path (machine_credential/service_agent → repo), NOT a
  divergent lib.
- **`POST /promote`** route + `makePromoteHandler` factory in `src/http/app.ts` (own auth middleware;
  reuses the terminal error handler + error opacity).
- **`PromoteService.promote(sessionId)`** orchestration: per accepted-and-unpromoted item → sanitize →
  judge (skip if already judged) → apply | quarantine; stale-target conflict → quarantine
  (reason `stale_target`), NO 3-way merge; `uncertain` items left un-applied → session
  `partially_promoted`.
- **Config**: `JUDGE_STUB`, `JUDGE_STUB_VERDICT`, `BEDROCK_MODEL_ID`, and an OIDC dev-bypass flag —
  all via the existing `z.enum(['true','false'])` + `superRefine` prod guard (NOT `z.coerce.boolean`).
- **Tests**: unit (DeterministicJudge, sanitize reuse, orchestration state machine, fail-closed judge),
  DB-gated integration (each op applied to real Postgres, dedup, concurrency conflict, quarantine,
  terminal states, idempotent re-run), supertest for `POST /promote` with the dev OIDC stub.

### OUT of scope (DEFERRED — AWS infra / follow-up)
- Real `BedrockJudge` model call (VPC PrivateLink + IAM + model-access grant) — skeleton only.
- Real GitHub-OIDC JWKS verification + API Gateway IAM authorizer config.
- GitHub Action YAML (PR-merge trigger + body construction).
- `machine_credential` provisioning for the Actions IAM role (seed a dev credential only).
- **Quarantine sweep/retention job** + the 1-vs-2-month retention decision.
- **3-way merge** reconciliation + **Web UI** human-review queue for `uncertain`.

## Constraints
- pnpm-ONLY; **no new runtime deps** for the local vertical (Bedrock SDK is only pulled when the real
  judge lands — a deferred, out-of-band `pnpm add`). Parameterized + tenant-scoped SQL; error opacity
  (4 codes); `content_tsv` never written; ESM `.js` imports; TDD (Vitest).
- **Secure-by-default & fail-closed**: judge errors → `uncertain` (never `accepted`); every stub/bypass
  guarded so it is impossible in production; sanitize before persist; quarantine stores redacted content.
- Idempotent: re-running `promote(sessionId)` must be a no-op for already-promoted items.

## Affected Areas
| Area | Change |
|------|--------|
| `src/db/promotionRepository.ts` | New — 4-op apply, dedup, FOR UPDATE, idempotency, quarantine, terminal state |
| `src/judge/{judge,deterministicJudge,bedrockJudge}.ts` | New — Judge seam + stub + fail-closed skeleton |
| `src/auth/{oidcAuthenticator,devOidcAuthenticator}.ts` | New — OIDC seam + dev stub |
| `src/promote/promoteService.ts` | New — orchestration state machine |
| `src/http/app.ts` + `src/http/promote.ts` | New route + handler factory |
| `src/config/index.ts` | New guarded env (JUDGE_STUB, verdict, BEDROCK_MODEL_ID, OIDC bypass) |
| `src/mcp/context.ts` / `src/index.ts` | Widen service bag; wire Judge + OIDC + PromoteService |
| `migrations/seed.dev.sql` | Seed a dev machine_credential + an accepted staging item to demo promote |
| `tests/**` | Unit + DB-gated integration + supertest |

(≫ 3 areas → design REQUIRED.)

## Open design decisions (for architect)
1. **Transaction granularity**: single all-or-nothing txn vs per-item txns (the latter enables
   `partially_promoted` + idempotent resume). Proposal leans per-item.
2. `PromotionRepository` as a new file vs extending `PgMemoryRepository`. Proposal leans new file.
3. Where authorization for `/promote` lives: add a `promote` ToolName to the existing authorizer vs a
   thin `PromoteAuthorizer` — must stay single-RBAC-lib. Architect decides.
4. Tenant resolution for `/promote`: reuse `remote_url` mapping vs a new `findRepoByGithubSlug`.
5. How far the `BedrockJudge` skeleton goes (pure interface + fail-closed wrapper with a TODO body,
   vs a real invoke) — proposal leans skeleton + fail-closed wrapper, real invoke deferred.
6. Exact conflict policy for stale target at apply time (quarantine vs uncertain). Proposal leans
   quarantine(reason=stale_target); confirm.

## Rejected alternatives
- **One monolith incl. real Bedrock + API Gateway + GitHub Action** — rejected: couples local logic to
  AWS provisioning; not testable in the harness; violates incremental delivery.
- **Split endpoint and core into two SDD changes** — rejected: the vertical is more valuable (and
  demoable) delivered whole; the endpoint is a thin factory over the orchestration. Kept as one change,
  internally batched.
- **Implement 3-way merge / Web UI now** — rejected (YAGNI): stale-target → quarantine is safe and
  sufficient for the pilot; reconciliation UI is a separate concern.
