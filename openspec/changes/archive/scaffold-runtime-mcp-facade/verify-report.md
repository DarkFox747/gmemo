# Verify Report — Scaffold Runtime + Minimal MCP Facade

schema: verify-report-v1
change: scaffold-runtime-mcp-facade

## Verdict: PASS

All 17 requirements satisfied at the stub/seam level. Zero CRITICAL. The single HIGH
(HTTP-boundary error opacity) and both MEDIUM findings were remediated in-phase and
re-verified green. Remaining items are LOW hardening or explicit carry-forwards to
changes B/C.

## Executor summary (3 parallel verifiers)

| Verifier | Result |
|----------|--------|
| Build worker (Bash) | build ✓ · tests **18/18** ✓ · lint ✓ (after remediation) |
| Reviewer (static, vs spec/design) | pass_with_findings — 0 CRITICAL, 1 HIGH, 2 MEDIUM, LOW |
| Security (OWASP-aware audit) | PASSED_WITH_TRACKED_ITEMS — 0 CRITICAL |

## Commands (final, post-remediation)

- `npm ci` → success (275 pkgs; `pnpm install` blocked by sandbox lockfile policy, npm fallback used)
- `npm run build` (tsc) → clean, 0 errors
- `npm test -- --run` (vitest) → **18/18 passed**, 5 files
- `npm run lint` (eslint src tests) → 0 errors

## Findings & resolution

### HIGH — resolved
- **H1 — HTTP-boundary error opacity (`src/http/app.ts`)**: no terminal error middleware;
  Express 5 default handler could leak `err.stack` in `development`. **FIX-1**: added a
  4-arg terminal error handler — logs server-side, responds fixed `{ error: "Internal
  server error" }` / 500, never leaks detail. Reviewer=HIGH, Security=MEDIUM (converged).

### MEDIUM — resolved
- **M1 — `LOG_LEVEL` validated but never applied**: **FIX-3** — `setLogLevel(config.LOG_LEVEL)`
  called at boot in `src/index.ts`.
- **M2 — transport cleanup only on `'finish'`, no failure path** (`src/mcp/transport.ts`):
  **FIX-2** — try/catch/finally; `next(err)` forwarding to H1 handler; `server.close()` in
  `finally` so it runs on every outcome.
- **Lint config gap (36 errors)**: **FIX-4** — `lint` scoped to `eslint src tests` (excludes
  `.claude/` framework scripts); `no-unused-vars` `argsIgnorePattern:"^_"` for intentional
  placeholder params; targeted empty-type suppression for `HandlerDeps`.

### LOW — addressed / accepted
- **Input bounds** (`src/mcp/tools/schemas.ts`): **FIX-5** — `query.max(1000)`, `limit.max(50)`.
- **`{} as any` deps in tests**: accepted for scaffold; tighten when change B introduces real `Deps`.
- **README run guide in Spanish**: accepted (project docs are Spanish; English-only targets memory content).
- **`.env.example`**: confirmed present at repo root (agents could not read it only due to the
  `.env*` permission rule); no secrets.
- **Accepted deviations**: `asCTR()` cast (SDK index-signature) and `GetContextRequest`
  eslint-disable — both correctly scoped and documented.

## Carry-forward requirements (MUST enter change C acceptance criteria)

1. **Replace `PlaceholderAuthorizer` (fail-open no-op) with real enforcement** — Cognito JWKS
   validation (iss, exp, token_use=access, client_id/scope) + RDS `project_membership` check —
   **before change B wires any real data source.** Ordering: C (enforcement) precedes B (data).
2. **Replace `PlaceholderTenantResolver`** — JWT sub + git-remote → RDS project/repo lookup.
3. **Replace `PLACEHOLDER_ACTOR`** in `src/mcp/tools/index.ts` with real JWT-claim parsing.
4. Add `helmet` + rate limiter on `POST /mcp` (edge/auth change).

Current-state safety: the fail-open authorizer is safe TODAY only because handlers return
static placeholder data and there is no tenant store — nothing to protect yet.

## Follow-up (change B, non-blocking now)
- Tighten `query`/`limit` bounds to contract-exact budgets when real search lands.
- Introduce the real `Deps` type and remove test `as any`.
