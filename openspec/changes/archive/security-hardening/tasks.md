# Tasks — security-hardening

`design.md` authoritative. No dep beyond `express-rate-limit` + `helmet` (T001 human).

- [x] T001 (HUMAN) `pnpm add express-rate-limit helmet`, commit `pnpm-lock.yaml`.
- [x] T002 `src/config/index.ts`: add `RATE_LIMIT_ENABLED` (enum true/false transform) + `RATE_LIMIT_MCP_WINDOW_MS`/`RATE_LIMIT_MCP_MAX`/`RATE_LIMIT_PROMOTE_WINDOW_MS`/`RATE_LIMIT_PROMOTE_MAX` (coerce int min 1, defaults 60000/120/60000/10); superRefine forbids `RATE_LIMIT_ENABLED=false` in production.
- [x] T003 `src/http/rateLimit.ts` (new): factory building the two configured limiters (opaque 429 `{ error: 'Too Many Requests' }`, standard headers, IP key).
- [x] T004 `src/http/app.ts`: apply `helmet({ contentSecurityPolicy: false })` globally (early) + `app.disable('x-powered-by')` + `app.set('trust proxy', 1)`; extend `createApp(services, options?)` with an options bag (rate-limiting DISABLED by default); mount the `/mcp` + `/promote` limiters BEFORE auth when enabled — without altering auth outcomes.
- [x] T005 `src/index.ts`: build the createApp options from config (rate-limiting ON; pass windows/max).
- [x] T006 `terraform/modules/service/main.tf`: add `RATE_LIMIT_ENABLED=true` to the task-def environment (prod guard). Keep terraform `fmt`/`validate` clean.
- [x] T007 Tests `tests/http/*`: 429 after N within the window; helmet headers present + `X-Powered-By` absent; per-IP keying (distinct `X-Forwarded-For`); confirm existing tests unaffected (limiter off by default). Add a helper to enable/lower limits deterministically.
- [x] T008 Gate: `pnpm install --frozen-lockfile && pnpm build && pnpm lint && pnpm test -- --run` + `terraform fmt -check -recursive terraform/ && (cd terraform/envs/pilot && terraform init -backend=false && terraform validate)`. All green.
