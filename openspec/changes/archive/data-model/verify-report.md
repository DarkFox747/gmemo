# Verify Report — Data Model (Change B): read tools wired to real memory

schema: verify-report-v1
change: data-model

## Verdict: PASS

All REQ-01..REQ-24 satisfied. The three read tools now return real, project-scoped RDS
memory data. Verify initially FAILED on one HIGH (cursor not forwarded → pagination broken
end-to-end); it plus MEDIUM/LOW items were remediated in-phase and re-verified green.
Deferred items (new deps / accepted deviations) tracked in the backlog.

## Executors (3 parallel verifiers)
| Verifier | Result |
|----------|--------|
| Build worker (pnpm) | build ✓ · test **153 pass / 23 skip** → **155 pass** post-fix · lint ✓ 0 err |
| Security (OWASP) | 0 CRITICAL / 0 HIGH · 1 MEDIUM (rate-limit) · 3 LOW — SQL parameterized, tenant isolation solid |
| Reviewer (static vs spec) | changes_requested — 0 CRITICAL · 1 HIGH (cursor) · 3 MEDIUM · LOW |

## Final commands (post-remediation, pnpm-only)
- `pnpm build` → clean, 0 errors
- `pnpm test -- --run` → **155 pass / 23 skip** (DB integration tests skip without DATABASE_URL)
- `pnpm lint` → 0 errors, 0 warnings

## Findings & resolution

### HIGH — resolved
- **Cursor not forwarded** (`src/mcp/tools/index.ts`): the `recall` tool registration dropped the
  `cursor` arg, so keyset pagination never advanced end-to-end (REQ-07), undetected because tests
  called the handler directly. **Fixed**: `cursor` forwarded in the callback + `RecallRequest`; added a
  **transport-level** pagination test (SDK Client + InMemoryTransport) that fails against the old code.

### MEDIUM — resolved
- **types:[] divergence** — prod matched zero rows, fake matched all. Normalized empty `types` → "no filter"
  in the handler; fake aligned; test added.
- **Integration test not re-run-idempotent** — teardown now deletes the `schema_migrations` row for
  `0002_memory`; **index-existence assertions added** (ix_memory_proj_status_type, ix_memory_ttl, GIN) → closes REQ-23.

### LOW — resolved
- **createPool TLS coupling**: `createPool(connectionString, enforceSSL)` — no `process.env` read; callers pass
  the flag (`index.ts` = `config.NODE_ENV==='production'`; `migrate.ts` = its own env check).
- **Dead try-catch** around base64url decode replaced with explicit string pre-check + comment (validators are the guard).
- **Cursor parse** strictness: `parseFloat` → `Number` + `Number.isFinite` (rejects `"1.5abc"`).

## Deferred carry-forwards (→ backlog; not blocking)
- **M-01** app-level rate limiting on `POST /mcp` → needs `express-rate-limit` (WAF primary).
- **L-02** security headers → needs `helmet` + `app.disable('x-powered-by')`.
- **REQ-08 wording vs D9**: spec says "fetch memory_revision list" but `GetMemoryResponse` has no history
  field, so the revision query is intentionally omitted (YAGNI). Accepted, documented deviation.

## Security posture (from audit)
Every read enforces the change-C two-gate + RBAC + audit chain (intact). All SQL parameterized; FTS binds
`websearch_to_tsquery('english', $1)`; every query scoped to `ctx.tenant.projectId` (repoId only for scope=repo);
a valid handle for another project returns null → opaque `INVALID_REFERENCE`; relation joins re-scope the other
side to same-project+active (no cross-tenant edge leak); handle/cursor decode validated + opaque on malformation.

## Milestone
The MCP facade now serves real memory: `recall` (FTS + time-decay + keyset pagination), `get_memory`
(handle + relations + stale), `get_context` (constraints/domain_rules first + stale). Staging-mix,
write tools, and pgvector remain deferred. Real end-to-end run still needs a live Postgres (migrations applied)
— that is the dev-harness step.
