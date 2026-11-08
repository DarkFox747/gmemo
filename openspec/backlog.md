# SDD Backlog — gmemo

Rename note: LPMS Cloud → gmemo (C0 demo-baseline, 2026-11-07); archived changes keep the original name.

Deferred work items, ordered. Promote to a `/sdd-new <name>` change when ready.

## Next changes (planned order)
1. ✅ **scaffold-runtime-mcp-facade** — DONE (archived, verify PASS).
2. ✅ **auth-two-gate** — DONE (archived, verify PASS).
3. ✅ **data-model (change B)** — DONE (archived, verify PASS). Read tools serve real RDS memory
   (recall FTS+keyset, get_memory, get_context). Staging + write path deferred.
4. ✅ **dev-harness** — DONE (archived, verify PASS). `docker compose up` boots pg + migrate + seed + app;
   Gate 1 stubbed behind a 4-barrier prod guard; Gate 2/RBAC/audit real. Human TODO: run `docker compose
   up --build` once on a Docker-capable machine (no daemon in the build env).
5. ✅ **write-path (write-to-staging slice)** — DONE (archived, verify PASS after remediation).
   staging tables (0003) + StagingRepository + remember/list_staged/discard_staged + RBAC write-roles
   + recordWrite audit (remember AND discard) + recall staging-mix (source:"staged"). 285 tests.
   Promotion pipeline SPLIT OUT → item 6.
6. ✅ **promotion-schema-gaps** — DONE (archived, verify PASS). Migration `0004`: `promoted_at`/
   `promoted_memory_id` (FK SET NULL), `partially_promoted` status, self-contained sweep-safe
   `quarantine` table. Schema-only groundwork; unblocks the pipeline without migrating a live table.
7. ✅ **promotion-pipeline (local-testable vertical)** — DONE (archived, verify PASS after remediation).
   `POST /promote` + injectable OIDC/Judge stubs → sanitize → apply to memory/memory_revision/
   memory_relation (4 ops, idempotent, per-item txns) → quarantine → terminal state. 371 tests.
   Real Bedrock/OIDC/API-Gateway/Action deferred behind the seams.
8. ✅ **hybrid-search (two-phase: lexical-first, semantic fallback)** — DONE (archived, verify PASS after
   remediation). Migration `0005` (vector ext + `embedding vector(1024)` + HNSW partial index); injectable
   `Embedder` seam (StubEmbedder now, Bedrock Titan v2 deferred); `recall` escalates to a vector NN search
   only when BM25 returns < N (default 5), fail-soft to BM25; embeddings written at promotion. 416 tests.
   NOTE: chose **two-phase** over RRF fusion (cost: common queries make 0 embedding calls). Real semantic
   quality needs the deferred real Bedrock embedder.
9. ✅ **real-bedrock-clients** — DONE (archived, verify PASS after remediation). Real Titan v2
   embedder (`InvokeModelCommand`) + Claude Haiku judge (`ConverseCommand`) behind the
   `BedrockInvoker` seam; `+@aws-sdk/client-bedrock-runtime`; `AWS_REGION`/timeout/retry config;
   fail-closed/fail-soft strengthened (word-boundary verdict, XML-delimited untrusted fields,
   error logging, safe stub default). 442 tests. Runs on real Bedrock when env-configured.
10. ✅ **terraform-infra** — DONE (archived, verify PASS after remediation). Single-AZ AWS pilot
    IaC: bootstrap (S3+DynamoDB state) + modules network/data/cognito/dns-tls/service. RDS pg16
    private + pgvector; REAL Cognito Gate 1 (admin-only pool, USER_PASSWORD_AUTH, MFA optional/TOTP);
    HTTPS end-to-end (ACM + Route53, :80→443 redirect); least-privilege Bedrock task role;
    NODE_ENV=production (all bypass/stubs off). `fmt`+`validate` clean. **`terraform apply` is
    out-of-band** (human/CI, needs AWS creds + real domain tfvars). User chose Option (a): prod auth now.
11. **infra-hardening** (NEXT, before/with prod-promotion) — flips accepted as pilot posture:
    ECR IMMUTABLE + git-SHA tags; RDS `deletion_protection`/`skip_final_snapshot=false`/Secrets
    `recovery_window>=7`; execution-role ECR-scoped inline policy; CloudWatch CMK; ALB access logs +
    WAF + rate-limit (M-02/L-01); ECS `deployment_configuration`; Multi-AZ; NAT/PrivateLink review.
12. ✅ **promote-oidc** — DONE (archived, verify PASS after remediation). Real GitHub-Actions OIDC
    verify (reused `aws-jwt-verify` `JwtRsaVerifier`, NO new dep) unblocks `/promote`; default-branch
    enforcement; `push`-to-default Action YAML (OIDC, no long-lived secret); migration `0006`
    UNIQUE(project_id,principal_name) + idempotent machine_credential provisioning SQL. Fail-closed;
    fork-PRs safe. 452 tests. API Gateway NOT needed (app verifies OIDC directly behind the ALB).
13. ✅ **security-hardening** — DONE (archived, verify PASS after remediation). `helmet`
    (CSP off for JSON API, `x-powered-by` off) + `express-rate-limit` on `/mcp` + `/promote`;
    `trust proxy=1` + explicit right-most-XFF `keyGenerator` (spoof-resistant, regression-tested);
    `RATE_LIMIT_*` config + prod guard; `RATE_LIMIT_ENABLED=true` in the task-def. 462 tests.
    Closes M-02 (rate limit) + L-01 (headers). Deps `express-rate-limit`+`helmet`.
14. **graph Layer 2** (LATER) — trace_call_path / get_architecture / search_graph; CI-built code graph.

## Deferred from security-hardening
- WAF rate rule for unauthenticated endpoints (`/health`, `GET/DELETE /mcp` 405) at GA.
- Shared/Redis-backed rate-limit store when scaling beyond the single Fargate task.

## Deferred from promote-oidc
- **M-02 rate limit** on `POST /promote` (`express-rate-limit`) before live traffic.
- Operator: set `GITHUB_OIDC_AUDIENCE` (tie to deployed host) + workflow var `GMEMO_OIDC_AUDIENCE`
  + promote endpoint URL; register `machine_credential` (runbook SQL, LOWERCASE repo slug); run migration 0006.
- Web UI human-review queue for `uncertain`; quarantine sweep/retention; 3-way merge for stale targets.

## Apply-time / operator notes (terraform-infra)
- Supply real `domain_name` + `route53_zone_name` (+ `create_hosted_zone` if no zone) and
  `alb_ingress_cidrs` (allowlist) in a private `*.tfvars` (NOT committed).
- `bedrock_model_arns` MUST include the cross-region **inference-profile ARN** (Converse evaluates
  the profile ARN) or the judge returns AccessDenied → uncertain (auto-promotion silently off).
- Runbook: bootstrap → apply (desired_count=0) → push image → run-task migrate (NOT seed) →
  admin-set-user-password [+MFA] → manual Gate-2 SQL (project+app_user+project_membership) →
  desired_count=1 → initiate-auth token → `https://<domain>/mcp`.
- Latent gap (backlog): `docker-compose.yml` omits `EMBEDDER_STUB` for the app service.

## Deferred from hybrid-search
- Query-embedding cache; backfill of pre-0005 embeddings; `CONCURRENTLY` index / live-table migration + rds_superuser grant.
- Weighted-score fusion / true RRF; score-threshold trigger; paginating semantic hits.

## Deferred from promotion-pipeline (AWS infra / follow-up)
- ✅ Real `BedrockJudge.invokeModel` — DONE in real-bedrock-clients (Converse). Needs IAM + model access at deploy.
- Injection classifier as a dedicated sanitize step (docs/04); XML delimiters + anti-injection prompt are the interim mitigation.
- Real GitHub-OIDC JWKS verification + API Gateway IAM authorizer + GitHub Action YAML + real machine_credential provisioning.
- Quarantine sweep/retention job + the 1-vs-2-month retention decision (`quarantine.expires_at` left NULL).
- 3-way merge for stale targets; Web UI human-review queue for `uncertain` items.
- **M-02 rate limit** now also covers `POST /promote` (express-rate-limit).

## Security hardening (needs new deps — `pnpm add` out-of-band, then agents frozen-install)
- **M-02** app-level rate limiting on `POST /mcp` → `express-rate-limit` (WAF is primary; this is defense-in-depth).
- **L-01** security headers → `helmet` + `app.disable('x-powered-by')`.
- **minimumReleaseAge** — ADDED to `.npmrc` (`minimum-release-age=10080`, 7 days). INERT until the
  pnpm pin is bumped from `pnpm@9.15.0` to `>= 10.16` (the version that honors it). Decision pending:
  bump `package.json` packageManager to a pnpm 10.16+ release + regenerate `pnpm-lock.yaml` (user out-of-band).

## Deferred (add as a next step once "part 1" — a runnable, data-backed server — is ready)
- **dev-harness** — make the MCP server locally runnable & testable end-to-end:
  - `Dockerfile` (Node app) + `docker-compose.yml` (app + `postgres:16` + auto-migrate).
  - dev `.env` with an explicit, production-guarded **auth bypass** (leverage the existing
    injectable CognitoVerifier interface) so the server boots without a real Cognito user pool.
  - "run in 2 commands" doc. Goal: `docker compose up` → `/health` + `/mcp` reachable for manual testing.
  - Rationale: after change C the server requires DB + Cognito to boot, so it is no longer
    runnable standalone like the scaffold was; the harness restores local testability.

## Known follow-ups (from prior verify reports / design carry-forwards)
- Service-agent (`machine_credential`) authentication — currently fail-CLOSED (deferred).
- Write tools + their RBAC (contributor/service_agent), staging, promotion pipeline.
- `/promote` endpoint (API Gateway, IAM/OIDC — not Cognito).
- Shared RBAC library extraction (single logic across Cognito + IAM/OIDC paths).
- pgvector semantic search; FTS dictionary `english` vs `simple`.
- Tighten `query`/`limit` bounds to contract-exact budgets when real search lands.
- Replace test `as any` for `deps` with the real `Deps` type.
- AWS infra / containerization for production (ECR + Fargate) — beyond dev-harness.

## Entrega 4 — demo (2026-11-08, branch `demo/e4`)

✅ Archived: C0 demo-baseline · C1 judge-structured-verdict · C2 web-api-and-review-queue · C3 quarantine-management · C4 memory-lifecycle · C5 direct-memory-management · C6 hybrid-search-rrf · C7 governance-web · C8 demo-kit. Report: `docs/demo/REPORTE-E4.md`.

### Follow-ups (from verify reports, all LOW/MEDIUM, none blocking)
1. ✅ Compensating un-claim after a post-claim restore failure (C3) — done in change `ci-and-security-followups` (a failed restore abandons its `restore/<id>` session and clears the `restored_*` label in one statement, only while the claimed item is untouched; a retry can claim it again).
2. ✅ Detector coverage gaps: `sk-proj-`, `github_pat_`, AWS secret access keys (C3) — done in change `ci-and-security-followups` (`openai_project_key` for every kind-prefixed `sk-<kind>-` family incl. Anthropic-style keys, `github_fine_grained_pat`, context-anchored `aws_secret_access_key` plus the access-key-id + bare-secret pair).
3. ✅ Audit row inside the write transaction for API writes (C2/C4) — done in change `ci-and-security-followups` (the write's own transaction writes the `access_log` row; an audit failure rolls the write back). A restore's claim stays its own earlier transaction; a failure after it is compensated by the un-claim (#1).
4. Per-user rate limiting for preview/create/amend and behind CloudFront (C2/C5).
5. `NODE_ENV` required with no default; rate limiters before body parsing (pre-existing).
6. ✅ Feature-branch session ↔ PR linking for `/promote` — done in change `feature-branch-promotion` (default-branch token + `pr_number`; server-side PR verification against GitHub remains out of scope).
7. Web: gate the dev-user selector to dev builds; Cognito PKCE login; screen-level component tests (C7).
8. Dev-user email allowlist (C2); refuse `judge_output_invalid` on human confirm (C5).
9. ✅ `openspec/project-map.yaml` fully refreshed (sdd-map-refresh, commit anchor set). Wrong node:test/npm tests area removed; web area context installed locally (`packages/web/CLAUDE.md` + `packages/web/.claude/skills/web-area/SKILL.md`, area-lint ok, gitignored).
10. `secret_assignment` tolerate JSON quoting; JWT detector cost on dot-less input; digest-pin the CI pgvector image (from C11 verify).
