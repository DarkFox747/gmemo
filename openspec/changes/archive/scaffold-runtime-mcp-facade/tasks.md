# Tasks — Scaffold Runtime + Minimal MCP Facade

schema: tasks-v1
change: scaffold-runtime-mcp-facade

Task groups are partitioned so no two groups write the same file (safe to run in
parallel). All file paths/exports are fully specified in design.md — workers MUST
follow design.md exactly for interface names, paths, and contract shapes.

## Group 1 — Foundation (config, contracts, errors, health)

- [x] T001 Create `package.json` — ESM (`"type":"module"`); deps `@modelcontextprotocol/sdk ^1`, `express ^5`, `zod ^3`; devDeps `typescript ^5`, `tsx ^4`, `vitest ^2`, `supertest ^7`, `@types/node`, `@types/express ^5`, `@types/supertest ^6`, `eslint ^9`, `typescript-eslint ^8`, `@eslint/js`, `prettier ^3`, `eslint-config-prettier ^9`; scripts `dev` (tsx watch src/index.ts), `build` (tsc), `start` (node dist/index.js), `test` (vitest run), `lint`, `format`. (REQ-01, REQ-03)
- [x] T002 Create `tsconfig.json` — strict, `module`/`moduleResolution` NodeNext, ESM, `outDir dist`, `rootDir src`, include src. (REQ-02)
- [x] T003 Create `vitest.config.ts` — node environment, include `tests/**`. (REQ-14)
- [x] T004 Create `eslint.config.mjs` — flat config (typescript-eslint + @eslint/js + eslint-config-prettier).
- [x] T005 Create `.prettierrc.json` — shared formatting rules.
- [x] T006 Create `.env.example` — documents `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL` (no secrets). (REQ-07)
- [x] T007 Create `src/config/index.ts` — zod env schema + `loadConfig()`, fail-fast at boot, safe defaults. (REQ-07)
- [x] T008 Create `src/observability/logger.ts` — minimal leveled console logger, no dependency.
- [x] T009 Create `src/errors/appError.ts` — `ErrorCode` enum (`CONTEXT_UNAVAILABLE`,`PERMISSION_DENIED`,`INVALID_REFERENCE`,`INTERNAL`) + `AppError` with generic opaque messages. (REQ-13)
- [x] T010 Create `src/errors/toToolResult.ts` — map handler output/throws to MCP tool results; opacity guarantee (no stack/tenant/resource leak). (REQ-13)
- [x] T011 Create `src/contracts/memory.ts` — `MemoryRecord`, `MemoryType`, `MemoryOrigin`, `MemorySource`, `MemoryRelation` (contract §1). (REQ-09)
- [x] T012 Create `src/contracts/tools.ts` — request/response types for `recall`, `get_memory`, `get_context` (contract §2). (REQ-09)
- [x] T013 Create `src/http/health.ts` — `GET /health` handler → 200 `{ status: "ok" }`. (REQ-05)

## Group 2 — MCP facade + HTTP wiring + entrypoint

- [x] T020 Create `src/mcp/context.ts` — `RequestContext`/`TenantContext`/`ActorIdentity`, seam interfaces `TenantResolver`/`Authorizer`/`AuditLogger` + `Placeholder*` impls loudly marked `TODO(change-B)` / `TODO(change-C)`. Placeholder authorizer is a documented no-op; placeholder resolver returns a fixed `PLACEHOLDER` tenant — NO fabricated multi-tenant logic. (REQ-11, REQ-12)
- [x] T021 Create `src/mcp/tools/schemas.ts` — zod input schemas for the 3 tools (single source for registration). (REQ-08, REQ-09)
- [x] T022 Create `src/mcp/tools/recall.ts` — `recallHandler(input, ctx, deps)` stub → contract-shaped `RecallResponse` (2 records: one `main`, one `staged`; `total_matches`=len; `cursor`=null; respect 120/200 budgets). (REQ-10)
- [x] T023 Create `src/mcp/tools/getMemory.ts` — `getMemoryHandler` stub → `GetMemoryResponse` (1 record, empty relations, empty references). (REQ-10)
- [x] T024 Create `src/mcp/tools/getContext.ts` — `getContextHandler` stub → `GetContextResponse` (leads with `constraint`+`domain_rule`, then a `decision`; one `stale:true`; all `source:main`). (REQ-10)
- [x] T025 Create `src/mcp/tools/index.ts` — `registerReadTools(server, deps)`: wraps handlers with seam calls (resolveTenant → authorize → auditRead) + error mapping via toToolResult. (REQ-08, REQ-13)
- [x] T026 Create `src/mcp/server.ts` — `createMcpServer(deps)` → `McpServer` with the 3 read tools registered. (REQ-08)
- [x] T027 Create `src/mcp/transport.ts` — stateless Streamable HTTP wiring: per-request transport + `McpServer` + `handleRequest`; `GET`/`DELETE /mcp` → 405. (REQ-06)
- [x] T028 Create `src/http/app.ts` — `createApp()` Express factory; wires `/health` and `POST/GET/DELETE /mcp`. (REQ-05, REQ-08)
- [x] T029 Create `src/index.ts` — entrypoint: loadConfig() → createApp() → listen; boot log. (REQ-01)

## Group 3 — Tests

- [x] T040 Create `tests/health.test.ts` — supertest: `GET /health` → 200 `{ status:"ok" }`. (REQ-15)
- [x] T041 Create `tests/mcp/recall.test.ts` — assert `recallHandler` output matches `RecallResponse` shape (all MemoryRecord keys; total_matches===results.length; cursor null; ≥1 `staged`; budgets). (REQ-16)
- [x] T042 Create `tests/mcp/getMemory.test.ts` — assert `getMemoryHandler` output matches `GetMemoryResponse` shape. (REQ-16)
- [x] T043 Create `tests/mcp/getContext.test.ts` — assert `getContextHandler` output: non-empty records, first is constraint|domain_rule, ≥1 `stale:true`, no `staged`. (REQ-16)
- [x] T044 Create `tests/mcp/registration.test.ts` — SDK `Client` + `InMemoryTransport`: `tools/list` returns exactly `recall`,`get_memory`,`get_context` with non-empty input schemas. (REQ-08)

## Group 4 — Docs (after source exists)

- [x] T050 Add a "Run" section to `README.md` documenting install / `pnpm dev` / `pnpm test` / `pnpm build`. (REQ-17)

## Finalization (verify phase)

- [x] T060 Run `pnpm install && pnpm build && pnpm test` — must succeed green (handled in verify).
