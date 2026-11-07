# Verify Report — Auth Two-Gate (Cognito JWT + RBAC, read path)

schema: verify-report-v1
change: auth-two-gate

## Verdict: PASS

All REQ-01..REQ-24 satisfied. The security-critical two-gate model is correctly
implemented. Verify initially FAILED on one HIGH (migration runner) + MEDIUM/LOW items;
all in-scope findings were remediated in-phase and re-verified green. Remaining items are
deferred carry-forwards (new deps or future semantics) tracked in the backlog.

## Executors (3 parallel verifiers)

| Verifier | Result |
|----------|--------|
| Build worker (pnpm) | frozen install OK · build ✓ · test **73 pass / 12 skip** · lint ✓ 0 err |
| Security (OWASP audit) | 0 CRITICAL / 0 HIGH · 2 MEDIUM · 10 LOW — core model correct |
| Reviewer (static vs spec/design) | changes_requested — 0 CRITICAL · 1 HIGH · 2 MEDIUM · 2 LOW |

## Final commands (post-remediation, pnpm-only)
- `pnpm build` (tsc) → clean, 0 errors
- `pnpm test -- --run` (vitest) → **73 pass / 12 skip** (migrate.integration skips without DATABASE_URL)
- `pnpm lint` → 0 errors, 0 warnings

## Findings & resolution

### HIGH — resolved
- **F1 — migration runner self-executed on import + no testable API + coupled to full config**
  (`src/db/migrate.ts`, `tests/db/migrate.integration.test.ts`): refactored to
  `export runMigrations(connectionString)`, CLI auto-run guarded by main-module check, no
  `loadConfig()` inside. Integration test now imports and calls it; skips cleanly without DATABASE_URL.

### MEDIUM — resolved
- **F2** ledger version stored without `.sql`; test aligned to bare `0001_auth_tenancy`.
- **F3** migration entrypoint needs only DATABASE_URL (no COGNITO_* to run a schema migration).
- **M-01** DB TLS enforced in production (`ssl: { rejectUnauthorized: true }` when NODE_ENV=production;
  local/dev left to the connection string).

### LOW — resolved
- F4 camelCase (`appliedCount`); F5 graceful shutdown (SIGTERM/SIGINT → close server + closePool);
  L-02 allowlist `.refine(len>0)` fail-fast; L-03 removed dead `COGNITO_REGION` (derived from pool id);
  L-04 case-insensitive Bearer (RFC 7235); L-05 `constantTimeEqual` helper added; L-06 explicit JSON
  body limit (64kb); L-08 non-AppError exceptions logged server-side before opaque mapping;
  cleared 3 unused eslint-disable warnings.

## Deferred carry-forwards (→ backlog; NOT blocking archive)
- **M-02** app-level rate limiting on `POST /mcp` — needs `express-rate-limit` (new dep); WAF is the
  primary control per design. `pnpm add express-rate-limit` out-of-band when wanted.
- **L-01** security headers (`helmet` + `disable('x-powered-by')`) — needs `helmet` (new dep).
- **L-07** exclude archived projects from tenant/RBAC queries — needs archival semantics defined.
- **L-09** `UNIQUE (project_id, principal_name)` on `machine_credential` — with the provisioning path.
- Service-agent (`machine_credential`) authentication — still fail-CLOSED (deferred, safe).

## Environment note
The `guard-package-manager` hook was hardened to pnpm-only + frozen-only on disk, but Claude Code
loads hooks at session start, so the NEW guard takes effect on the next session. This session still
runs the previous hook; build/test/lint are unaffected (only install ops are guarded).

## Security posture (from audit)
Gate 1 JWKS correct (aud not validated, client_id allowlist, token_use=access, exp, scope; cache+rotation).
Gate 2 requires enabled app_user AND membership; global role does not bypass; roles sourced from RDS.
All SQL parameterized; opacity byte-identical across denials; query_hash server-side; machine path
fail-closed. No CRITICAL/HIGH.
