# Apply Progress — Scaffold Runtime + Minimal MCP Facade

schema: apply-progress-v1
change: scaffold-runtime-mcp-facade
mode: automatic

## Batch 1 (3 parallel workers)

### Completed tasks
- Group 1 (foundation): T001–T013
- Group 2 (MCP facade + HTTP wiring + entrypoint): T020–T029
- Group 3 (tests): T040–T044
- Group 4 (docs): T050 (README "Cómo correr" section, done inline by orchestrator)

### Files created (28 source/config/test + 1 doc edit)
Config/root: package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs,
  .prettierrc.json, .env.example
src/: config/index.ts, observability/logger.ts, errors/appError.ts,
  errors/toToolResult.ts, contracts/memory.ts, contracts/tools.ts, http/health.ts,
  http/app.ts, index.ts, mcp/context.ts, mcp/transport.ts, mcp/server.ts,
  mcp/tools/schemas.ts, mcp/tools/recall.ts, mcp/tools/getMemory.ts,
  mcp/tools/getContext.ts, mcp/tools/index.ts
tests/: health.test.ts, mcp/recall.test.ts, mcp/getMemory.test.ts,
  mcp/getContext.test.ts, mcp/registration.test.ts
docs: README.md (Run section appended)

### Worker-reported verification
- Group 1: `tsc --noEmit` + ESLint on batch files → PASS
- Group 2: `tsc --noEmit && vitest run` → PASS, 18 tests green
- Group 3: files created; runner deferred to scaffold worker (ran green in Group 2)

### Deviations from design
- `tools/index.ts` needed a local `asCTR()` adapter: the SDK's `CallToolResult`
  carries a `[x: string]: unknown` index signature that `ToolTextResult` lacks;
  resolved with a safe runtime cast. (Documented by Group 2 worker.)
- `GetContextRequest` empty-interface ESLint rule suppressed with a targeted
  eslint-disable to preserve the exact contract §2 shape.
- Test handler calls pass `{} as any` for `deps` (stubs don't branch on deps);
  to be replaced with the real `Deps` type in change B/C.

### Issues / blockers
None. All batch tasks complete.

## Batch 2 — verify remediation (1 worker)

### Completed
- FIX-1 (HIGH): terminal Express error handler → `src/http/app.ts`
- FIX-2 (MEDIUM): transport try/catch/finally + next(err) → `src/mcp/transport.ts`
- FIX-3 (MEDIUM): setLogLevel(config.LOG_LEVEL) at boot → `src/index.ts`
- FIX-4 (lint): `lint` scoped to `src tests` + underscore ignore + empty-type suppress
  → `package.json`, `eslint.config.mjs`, `src/mcp/context.ts`
- FIX-5 (LOW): input bounds `query.max(1000)`, `limit.max(50)` → `src/mcp/tools/schemas.ts`
- T060: clean-state `build && test && lint` → all green (18/18 tests, lint 0 errors)

### Verification (final)
`npm run build && npm test -- --run && npm run lint` → all PASS.

## Status: COMPLETE — verify PASS, archived.
