# Proposal — Auth Two-Gate (Cognito JWT + RBAC, read path)

schema: proposal-v1
change: auth-two-gate
status: draft
author: sdd-orchestrator
depends_on: scaffold-runtime-mcp-facade (archived)
blocks: data-model (change B) — this change MUST ship before real memory data is wired

## Problem / Motivation

The scaffold exposes the MCP read tools behind fail-open placeholder auth. Per the
scaffold's verify-report carry-forward, real enforcement MUST exist before any real data
source is wired (change B). This change replaces the placeholders with the real two-gate
model (Cognito JWT + RDS-backed RBAC) for the **interactive human read path**, and lands
the auth/tenancy RDS tables + a DB layer that both this change and change B build on.

## Chosen Approach

Implement the full authenticated read path end-to-end for human (OAuth2.1+PKCE → Cognito)
principals:
1. **Gate 1 (stateless)** — validate the Cognito access token via JWKS (`iss`,
   `token_use=access`, `exp`, `client_id` allowlist, `scope`; **not `aud`**).
2. **Tenant resolution** — `repo.remote_url` → `project`, from a client-supplied git remote.
3. **Gate 2 (human)** — `app_user` by `idp_subject` (JWT sub), must be `disabled_at IS NULL`.
4. **RBAC (read)** — require a `project_membership` row (viewer+) for the resolved project;
   the resolved `ActorIdentity{actorId, roles}` is produced here (fixes the actor gap).
5. **Audit** — write `access_log` with a **server-computed** `query_hash` on every read.

Real implementations are **singletons injected at boot** (JWKS cache + DB pool), replacing
the per-request `new` placeholders. The seam call order becomes:
`authenticate (Gate 1) → resolveTenant → authorize (Gate 2 + RBAC → ActorIdentity) → audit → handler`.

### Scoping decisions I am making (flag me to change any)

- **D1 — Auth/tenancy tables + DB layer land in THIS change (C), not B.** C introduces the
  `pg` client + migration tooling and migrates only the auth/tenancy tables (`app_user`,
  `project`, `repo`, `project_membership`, `machine_credential`, `access_log`). Change B
  adds the memory/staging tables on the same DB layer. Rationale: these tables ARE the
  enforcement; splitting them out keeps "C before B" coherent.
- **D2 — Machine/service-agent path is fail-CLOSED (deny) in this change.** `machine_credential`
  table is created, but service-agent authentication is deferred to a follow-up change. A
  deny placeholder is safe (service agents simply cannot read yet); a fail-open one would not.
- **D3 — gitRemote/branch are carried via custom headers `X-Git-Remote` / `X-Git-Branch`**
  for the pilot, validated server-side. The client-side hook that sets them is a skill/CI
  concern, tracked separately.
- **D4 — Global-role bypass: platform_owner/platform_admin still require a `project_membership`
  row for read access** (least privilege; no implicit cross-project read). Revisit if ops needs it.
- **D5 — `ActorIdentity.actorId` = raw JWT `sub`** (UUID) for the human path; `access_log.actor_kind = user`.
- **D6 — Write-tool RBAC (contributor/service_agent), `/promote` (IAM/OIDC via API Gateway),
  and the shared-RBAC-lib extraction are OUT of scope** — only the 3 read tools are wired here.
- **D7 — JWT/JWKS via `aws-jwt-verify`** (AWS-maintained, Cognito-aware, caches JWKS, verifies
  the exact access-token claim set incl. client_id) rather than hand-rolling on `jose`.

## Scope

### IN scope
- DB layer: `pg` connection pool + a minimal migration runner; `DATABASE_URL` config.
- Migration: auth/tenancy tables per schema v2 (app_user, project, repo, project_membership,
  machine_credential, access_log) + required enums/indexes/constraints.
- Gate 1 JWKS validation (aws-jwt-verify); Cognito env config + fail-fast validation.
- Tenant resolution from `X-Git-Remote` header → repo → project.
- Gate 2 (human) + read RBAC (viewer+) → produces ActorIdentity.
- Audit logging with server-side `query_hash`.
- Singleton dep injection refactor in transport; replace all three placeholders (machine
  path deny-only).
- Tests: token validation (valid/invalid/expired/wrong client_id), tenant-not-found,
  user-disabled/absent, no-membership denial, happy-path read + audit row written, opacity
  of every denial, machine path denied.

### OUT of scope (deferred)
- Service-agent (`machine_credential`) authentication logic → follow-up change.
- Write tools + their RBAC, staging, promotion.
- `/promote` (API Gateway IAM/OIDC) and the shared-RBAC-lib extraction.
- Memory/staging tables + repositories (change B).
- Cognito user pool / Lambda domain-trigger provisioning (infra, not app code).
- Real client hook that sets `X-Git-Remote` (skill/CI change).

## Affected Areas

| Area | What changes | New/Modified |
|------|--------------|--------------|
| DB layer | pg pool + migration runner + DATABASE_URL config | New |
| Auth/tenancy migration | 6 tables + enums/indexes (schema v2 subset) | New |
| Gate 1 (JWKS) | token validator (aws-jwt-verify) + Cognito config | New |
| Tenant + Gate 2 + RBAC | real TenantResolver + Authorizer (RDS), ActorIdentity sourcing | Modified (seams) |
| Audit | AuditLogger → access_log with server-side query_hash | Modified (seam) |
| Transport wiring | singleton dep injection; X-Git-Remote/Branch extraction | Modified |
| Tests | auth + tenant + RBAC + audit + opacity suite | New |

_7 affected areas → NOT a simple change; design phase runs (not skipped)._

## Constraints (from design + carry-forwards)

- Error opacity: all denials generic, no tenant/resource enumeration (reuse AppError path).
- `machine_credential.token_hash` compares (when implemented) MUST be constant-time.
- Prefer RDS `global_role` over any token claim (avoid stale-claim escalation).
- `query_hash` computed server-side only; raw query never logged.
- Stateless compute: JWKS cache + DB pool are process-level, not per-session state.
- YAGNI: only `aws-jwt-verify` + `pg` (+ a tiny migration runner) as new deps.
- Keep handlers unchanged in shape; auth plugs into seams only.

## Open Decisions Touched (design must confirm)
- Machine-credential Gate-1 semantics (Cognito token vs raw bearer) — parked by D2.
- JWKS cache TTL / rotation (aws-jwt-verify handles refresh-on-unknown-kid — confirm config).
- Canonical `actor_identity` format for audit (D5 sets raw sub for now).

## Rejected Alternatives
- **Hand-rolled JWT on `jose`** — more code, easy to get the Cognito claim set wrong
  (aud vs client_id). Rejected in favor of `aws-jwt-verify` (D7).
- **Auth tables in change B** — would put real data + enforcement in one change and violate
  the "C before B" safety ordering. Rejected (D1).
- **Consolidating auth into a single seam** (Option B from exploration) — breaks the
  interface SRP; kept authenticate/resolve/authorize as distinct steps (Option A).
- **Implementing the service-agent path now** — expands scope and risks a half-wired second
  Gate-2 path; deferred fail-closed (D2).

## Risks
- Transport singleton-injection refactor touches context.ts + transport.ts + tools/index.ts
  (highest-friction edit) — mitigated by not reshaping handler signatures.
- Migration tooling is new surface; keep it minimal (forward-only SQL files + a runner) to
  avoid a heavy dependency.
- `X-Git-Remote` is a pilot convention; document clearly so change B's data path relies on it.

## Next Phases
specs ∥ design → tasks → apply → verify → archive.
