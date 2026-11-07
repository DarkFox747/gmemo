---
schema: design-v1
change: scaffold-runtime-mcp-facade
project: lpms-cloud
status: proposed
authoritative_refs:
  - docs/artefactos/lpms_facade_contract_v1.md
  - openspec/project-map.yaml
---

# Design: Scaffold Runtime + MCP Facade (Read-Tool Stubs)

## Technical Approach

This change stands up the first runnable slice of the LPMS Cloud service: a
Node.js + TypeScript process that boots, serves an unauthenticated `/health`
endpoint over Express, and exposes an MCP server whose three READ tools
(`recall`, `get_memory`, `get_context`) are **typed stubs** returning
placeholder data whose shapes match `lpms_facade_contract_v1.md` exactly.

The design maps directly onto the `facade-mcp` module boundary from the project
map. Only the read-tool surface is realized; `remember`, staging, graph tools,
persistence, tenant resolution, and RBAC enforcement are **explicit seams**, not
implementations. The guiding principle is that change **B** (data model /
persistence) and change **C** (auth / RBAC) must be able to plug into the seams
**without reshaping** the tool handlers, contract types, or the HTTP/MCP wiring.

Everything is stateless: no in-memory session store, no cross-request state. The
MCP transport runs in stateless mode so the process can scale horizontally
behind the ALB (per `infra` topology) without sticky sessions. All source
content and identifiers are in English.

## Architecture Decisions

### Decision: MCP over stateless Streamable HTTP, mounted as an Express route

**Choice**: One Node HTTP process. Express owns the socket. `/health` is a plain
Express route. MCP is mounted at `POST /mcp` using the official SDK's
`StreamableHTTPServerTransport` in **stateless mode** (`sessionIdGenerator:
undefined`). Each `POST /mcp` instantiates a fresh transport + `McpServer`
instance, connects them, and calls `transport.handleRequest(req, res, body)`.
`GET /mcp` and `DELETE /mcp` return `405` (no server-initiated SSE stream in
stateless mode).

**Alternatives considered**:
- *Deprecated HTTP+SSE transport* (`SSEServerTransport`): superseded by
  Streamable HTTP in the current SDK; requires a long-lived per-client stream
  and server-side session affinity.
- *stdio transport*: only suitable for a locally-spawned child process, not a
  cloud service fronted by an ALB.
- *Stateful Streamable HTTP* (session IDs + resumable streams): holds
  per-session state in the process, breaking the stateless-compute constraint
  and complicating horizontal scaling.
- *Separate MCP process/port from the HTTP API*: two listeners, two health
  surfaces, more infra for zero current benefit.

**Rationale**: The `infra` map fronts the MCP surface with an ALB and requires
stateless Fargate/EC2 compute. Stateless Streamable HTTP is the SDK's
recommended transport for exactly this shape and needs no sticky sessions.
Mounting on a single Express app keeps one process, one port, one health check
for the vertical slice while leaving room for the web API + `/promote` surfaces
(API Gateway) to be added as separate concerns later. Per-request server/
transport instantiation is the SDK's documented stateless pattern and enforces
"no in-memory session state" structurally.

### Decision: Module layout mirrors `facade-mcp`, with contracts isolated from wiring

**Choice**: `src/` is split into `contracts/` (pure types matching the facade
contract), `mcp/` (server, transport, context seams, tool handlers), `http/`
(Express app + health), `errors/`, `config/`, and `observability/`. Tool
handlers are exported **pure async functions** `(input, ctx, deps) => Promise<Response>`;
MCP registration is a thin wrapper that supplies `ctx` and `deps`.

**Alternatives considered**:
- *Handlers coupled to the MCP SDK request object*: makes them impossible to
  unit-test without a transport and leaks SDK types into business logic.
- *Flat `src/` with everything at top level*: does not reflect the module map
  and gives change B/C no obvious insertion points.

**Rationale**: Separating the contract types from transport/wiring means change
B fills handler bodies (swap stub data for a repository call) without touching
the contract, the MCP registration, or the HTTP layer. Pure-function handlers
are directly unit-testable for response shape — the core of this change's test
strategy.

### Decision: Config via a small zod-validated env loader (no config framework)

**Choice**: `src/config/index.ts` reads `process.env` through a zod schema
(`PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`) with safe defaults, validated **once
at boot**. Invalid config fails fast before the server listens. zod is already a
required dependency (the MCP SDK uses zod raw shapes for tool `inputSchema`), so
this adds no new dependency.

**Alternatives considered**:
- *`dotenv` + `convict`/`env-var`*: extra runtime dependencies for a four-key
  config surface — violates YAGNI.
- *Raw `process.env` reads scattered across modules*: no validation, no single
  source of truth, easy to leak undefined into runtime.

**Rationale**: zod is already in the tree for tool schemas, so reusing it for
config validation is free and consistent. Fail-fast boot validation is
secure-by-default and avoids a class of "undefined env" runtime surprises.

### Decision: Opaque error convention centralized in `src/errors/`

**Choice**: A closed `ErrorCode` set — `CONTEXT_UNAVAILABLE`,
`PERMISSION_DENIED`, `INVALID_REFERENCE`, `INTERNAL` — carried by an `AppError`
class. Each code maps to a **generic, non-enumerating** message (contract §6).
A single `toToolErrorResult(err)` helper converts any thrown error into an MCP
tool error result: known `AppError`s emit their generic message; anything else
collapses to `INTERNAL` with a fixed message and no detail. Raw errors, stack
traces, tenant names, and resource IDs are never returned to the agent.

**Alternatives considered**:
- *Let exceptions propagate to the SDK's default serializer*: risks leaking
  internal messages / stack detail to the agent, violating error opacity.
- *Per-tool ad-hoc error strings*: drifts over time, no single opacity guarantee.

**Rationale**: Contract §6 and the `errors` convention (`no tenant/resource
enumeration; generic denials`) are hard requirements. Centralizing the mapping
makes opacity a property of the system, not of each handler's discipline. The
scaffold stubs take the happy path, but the convention is in place from day one
so change B/C throw `AppError`s and inherit opacity for free.

### Decision: Stub data is contract-shaped and obviously placeholder

**Choice**: Each read tool returns a small set of static records built from the
`MemoryRecord` type. Placeholder values are self-identifying (e.g.
`handle: "stub-recall-1"`, `title: "Placeholder decision record"`) so no
consumer mistakes them for real memory. Handlers accept a `RequestContext` and a
`deps` object but **do not branch on tenant** — they return the same placeholder
regardless, because there is no tenant data yet.

**Alternatives considered**:
- *Return empty arrays*: technically valid but does not exercise or document the
  full record shape, weakening the contract-conformance tests.
- *Return randomized/faker data*: adds a dependency and non-determinism, making
  shape assertions flaky.

**Rationale**: The whole point of the slice is to lock the response **shape** to
the contract so change B can swap the data source without reshaping. Static,
deterministic, clearly-labelled placeholders make the shape tests meaningful and
prevent accidental reliance on stub content.

## Data Flow

    MCP agent (client)
        │  POST /mcp  (Streamable HTTP, JSON-RPC)
        ▼
    ALB (infra) ──► Express app  ──►  GET /health ──► { status: "ok" }
        │                 │
        │                 └─ POST /mcp
        ▼
    StreamableHTTPServerTransport (stateless, per-request)
        │
        ▼
    McpServer  ──► tool wrapper
                        │  1. resolveTenant()   ◄── SEAM (change B)  [placeholder]
                        │  2. authorize(tool)   ◄── SEAM (change C)  [placeholder no-op]
                        │  3. auditRead()        ◄── SEAM (change B, access_log) [TODO]
                        ▼
                   tool handler (pure)  ──► contract-shaped placeholder data
                        │
                        ▼
                   toToolResult() ──► JSON-RPC response
                        │  (on throw) toToolErrorResult() ──► generic opaque error

Errors never carry tenant/resource identity. Config is validated once at boot,
before the socket is opened.

## Tool Stub Contracts

All types live in `src/contracts/` and mirror `lpms_facade_contract_v1.md` §1–§2.
The shared record shape (contract §1):

```ts
// src/contracts/memory.ts
export type MemoryType =
  | 'decision' | 'constraint' | 'gotcha' | 'pattern'
  | 'integration_note' | 'domain_rule' | 'outcome';

export type MemorySource = 'main' | 'staged';

export interface MemoryOrigin {
  branch: string;        // literal originating branch name (contract §1)
  pr: number | null;     // PR number, or null if none yet
}

export interface MemoryRecord {
  handle: string;        // opaque, per-recall, bound to (memory_id, revision)
  type: MemoryType;
  title: string;         // <= 120 chars
  summary: string;       // <= 200 chars — the "what" in one line
  body: string;          // markdown, <= 2000 chars — rationale
  fields: Record<string, unknown>; // per-type fields (contract §1)
  date: string;          // ISO-8601 (promotion date)
  origin: MemoryOrigin;
  source: MemorySource;  // "main" | "staged"
  stale?: boolean;       // set by get_context for TTL-expired-but-active
}

// relation edge types come from data_model.memory.memory_relation
export type MemoryRelationType = 'supersedes' | 'conflicts_with' | 'duplicate';
export interface MemoryRelation { type: MemoryRelationType; handle: string; }
```

Note: `status` is intentionally absent from `MemoryRecord` — the server only
ever returns `active` records (contract §1).

### recall(query, scope?, types?, limit?)

Contract §2 "recall": hybrid search; returns whole records ranked with
time-decay, plus `total_matches` and a `cursor` for the next page.

```ts
// src/contracts/tools.ts
export interface RecallRequest {
  query: string;                 // required
  scope?: 'repo' | 'project';    // default 'project' (contract §2)
  types?: MemoryType[];          // optional filter; default all
  limit?: number;                // default 8 (contract §2 / §8)
}

export interface RecallResponse {
  results: MemoryRecord[];       // whole records (contract §2/§8)
  total_matches: number;
  cursor: string | null;         // null when no further page
}
```

**Stub returns**: a `RecallResponse` with two placeholder `MemoryRecord`s (one
`source: "main"`, one `source: "staged"` to exercise the staging-mix rule of
contract §5), `total_matches` matching the array length, and `cursor: null`.

### get_memory(handle)

Contract §2 "get_memory": one record in full detail + relations
(`supersedes` / `conflicts_with`) + references.

```ts
export interface GetMemoryRequest { handle: string; }

export interface GetMemoryResponse {
  memory: MemoryRecord;
  relations: MemoryRelation[];   // supersedes / conflicts_with / duplicate
  references: string[];          // opaque handles referenced by this record
}
```

**Stub returns**: a `GetMemoryResponse` with one placeholder `MemoryRecord`, an
empty `relations` array, and an empty `references` array. (Empty relation/ref
arrays are the correct shape for an isolated record and keep the stub honest —
it invents no fake edges.)

### get_context()

Contract §2 "get_context": no query. Always returns active `constraint` +
`domain_rule` for the repo/project (priority, never budget-dropped), plus recent
`decision` + `gotcha`; excludes `superseded`/`deprecated`; includes
TTL-expired-but-active marked `stale: true`.

```ts
export interface GetContextRequest {}   // no params

export interface GetContextResponse {
  records: MemoryRecord[];  // whole records, constraints/domain_rules first
}
```

**Stub returns**: a `GetContextResponse` whose `records` lead with one
`constraint` and one `domain_rule` placeholder, followed by one recent
`decision`, with one record flagged `stale: true` to exercise the TTL-marking
rule. All `source: "main"`.

## Tech Context / Dependencies

Runtime `dependencies`:

| Package | Version approach | Why |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.x` (latest stable at scaffold; exact pin in lockfile) | Official MCP TypeScript SDK — `McpServer` for tool registration and `StreamableHTTPServerTransport` for the stateless HTTP transport. Non-negotiable for the facade. |
| `express` | `^5.x` | Owns the HTTP socket; serves `/health` and mounts `POST /mcp`. Design map assumes an ALB-fronted HTTP service. |
| `zod` | `^3.x` | Required by the MCP SDK to declare tool `inputSchema` as raw shapes; reused for boot-time env-config validation. Not an extra dependency. |

Dev `devDependencies`:

| Package | Version approach | Why |
|---|---|---|
| `typescript` | `^5.x` | Type checking + build. |
| `tsx` | `^4.x` | Run TS directly for `dev` (`tsx watch src/index.ts`) — no separate build step in the dev loop. |
| `vitest` | `^2.x` | Test runner chosen in the proposal (faster, less config than Jest, native ESM/TS). |
| `supertest` | `^7.x` | Drives the `/health` endpoint over HTTP in-process for an integration-level assertion. |
| `@types/node` | matches Node LTS | Node typings. |
| `@types/express` | `^5.x` | Express typings (Express 5 ships without bundled types). |
| `@types/supertest` | `^6.x` | supertest typings. |
| `eslint` + `typescript-eslint` + `@eslint/js` | `^9.x` / `^8.x` | Flat-config linting (the "lint" scope item). |
| `prettier` + `eslint-config-prettier` | `^3.x` / `^9.x` | Consistent formatting for a team scaffold; `eslint-config-prettier` prevents rule conflicts. |

Explicitly **excluded** (YAGNI): `dotenv`, `pino`/`winston` (a thin console
logger suffices), `pg`/`drizzle`/any DB driver (change B), `jsonwebtoken`/
`jwks-rsa` (change C), `helmet`/rate-limiters (belong with the auth/edge change),
`faker`. Node target is the current LTS; project is ESM (`"type": "module"`).

## Seams for Later Changes

Seams live in `src/mcp/context.ts` and are wired into the tool wrapper so later
changes swap implementations **without reshaping handlers**.

```ts
// src/mcp/context.ts
export interface TenantContext {   // shape stabilized here; populated by change B
  projectId: string;
  repoId: string;
  branch: string;
}
export interface ActorIdentity {   // shape stabilized here; populated by change C
  actorId: string;
  roles: string[];
}
export interface RequestContext { tenant: TenantContext; actor: ActorIdentity; }

// SEAM — change B: resolve tenant from token + git remote (facade contract §0).
export interface TenantResolver {
  resolve(input: TenantResolutionInput): Promise<TenantContext>;
}

// SEAM — change C: enforce project_membership per request (contract §4).
export type ToolName = 'recall' | 'get_memory' | 'get_context';
export interface Authorizer {
  authorize(ctx: RequestContext, tool: ToolName): Promise<void>; // throws AppError(PERMISSION_DENIED)
}

// SEAM — change B: access_log write (contract §7); query_hash, never raw text.
export interface AuditLogger {
  recordRead(ctx: RequestContext, tool: ToolName, queryHash?: string): Promise<void>;
}
```

Scaffold placeholders (in the same file, loudly commented):
- `PlaceholderTenantResolver.resolve()` returns a fixed, clearly-labelled
  `TenantContext` (e.g. `projectId: "PLACEHOLDER"`). It performs **no real
  remote→project mapping** — that is change B. It does not fabricate multi-tenant
  logic; it is a single static value marked `// TODO(change-B)`.
- `PlaceholderAuthorizer.authorize()` is a **documented no-op**
  `// TODO(change-C): enforce project_membership (contract §4)`.
- `PlaceholderAuditLogger.recordRead()` is a **documented no-op**
  `// TODO(change-B): write access_log with query_hash (contract §7)`.

**Security note (must carry into change C):** the placeholder authorizer is
fail-open. This is acceptable *only* because the scaffold serves static
placeholder data and touches no tenant store — there is nothing to protect yet.
Change C **must** replace `PlaceholderAuthorizer` before any real data source is
wired (change B). This is recorded as a risk below and belongs in change C's
acceptance criteria.

## File Changes

| File | Action | Description |
|---|---|---|
| `package.json` | Create | ESM package; deps/devDeps above; scripts: `dev` (tsx watch), `build` (tsc), `start`, `test` (vitest), `lint`, `format`. |
| `tsconfig.json` | Create | Strict TS, `NodeNext` module/resolution, ESM, `outDir dist`, `src` root. |
| `vitest.config.ts` | Create | Vitest config (node environment, `tests/**` include, coverage optional). |
| `eslint.config.mjs` | Create | Flat ESLint config (typescript-eslint + `@eslint/js` + `eslint-config-prettier`). |
| `.prettierrc.json` | Create | Formatting rules shared by the team. |
| `.gitignore` | Create | Ignore `node_modules`, `dist`, `.env`, coverage. |
| `.env.example` | Create | Documents `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL` (no secrets). |
| `src/index.ts` | Create | Entrypoint: load+validate config, build Express app, listen; boot log. |
| `src/config/index.ts` | Create | zod env schema + typed `loadConfig()`; fail-fast on invalid env. |
| `src/observability/logger.ts` | Create | Minimal leveled console logger (no dependency); swappable later. |
| `src/http/app.ts` | Create | `createApp()` Express factory; wires `/health` and `POST/GET/DELETE /mcp`. |
| `src/http/health.ts` | Create | `GET /health` handler → `{ status: "ok" }` + 200. |
| `src/errors/appError.ts` | Create | `ErrorCode` enum + `AppError` with generic opaque messages (contract §6). |
| `src/errors/toToolResult.ts` | Create | Maps handler output/throws to MCP tool results; opacity guarantee. |
| `src/contracts/memory.ts` | Create | `MemoryRecord`, `MemoryType`, `MemoryOrigin`, `MemorySource`, `MemoryRelation` (contract §1). |
| `src/contracts/tools.ts` | Create | Request/response types for `recall`, `get_memory`, `get_context` (contract §2). |
| `src/mcp/context.ts` | Create | `RequestContext`, `TenantContext`, `ActorIdentity`, seam interfaces + placeholder impls (changes B/C). |
| `src/mcp/transport.ts` | Create | Stateless Streamable HTTP wiring: per-request transport + `McpServer` + `handleRequest`. |
| `src/mcp/server.ts` | Create | `createMcpServer(deps)` → `McpServer` with the 3 read tools registered. |
| `src/mcp/tools/schemas.ts` | Create | zod input schemas for the 3 tools (single source for registration). |
| `src/mcp/tools/recall.ts` | Create | `recallHandler(input, ctx, deps)` stub → contract-shaped `RecallResponse`. |
| `src/mcp/tools/getMemory.ts` | Create | `getMemoryHandler(input, ctx, deps)` stub → `GetMemoryResponse`. |
| `src/mcp/tools/getContext.ts` | Create | `getContextHandler(input, ctx, deps)` stub → `GetContextResponse`. |
| `src/mcp/tools/index.ts` | Create | `registerReadTools(server, deps)`: wraps handlers with seams + error mapping. |
| `tests/health.test.ts` | Create | supertest: `GET /health` → 200 and `{ status: "ok" }`. |
| `tests/mcp/recall.test.ts` | Create | Asserts `recallHandler` output matches `RecallResponse` shape (records, total_matches, cursor). |
| `tests/mcp/getMemory.test.ts` | Create | Asserts `getMemoryHandler` output matches `GetMemoryResponse` shape. |
| `tests/mcp/getContext.test.ts` | Create | Asserts `getContextHandler` output matches `GetContextResponse`, incl. a `stale` record. |
| `tests/mcp/registration.test.ts` | Create | Via SDK `InMemoryTransport` + `Client`: `tools/list` returns exactly `recall`, `get_memory`, `get_context` with input schemas. |

## Test Strategy

Framework: **Vitest** (this change also flips `tests.framework` to `vitest` in
the project map on the follow-up `sdd-init`). First green tests:

1. **Health endpoint** (`tests/health.test.ts`) — start the Express app via
   `createApp()` and use supertest to assert `GET /health` returns `200` and
   body `{ status: "ok" }`. Proves the process boots and serves HTTP.
2. **Per-tool shape conformance** (`tests/mcp/*.test.ts`) — call each handler
   directly with valid input and a placeholder `RequestContext`, then assert the
   returned object conforms to the contract shape:
   - `recall`: `results` is an array of records each carrying every
     `MemoryRecord` key (`handle`, `type`, `title`, `summary`, `body`, `fields`,
     `date`, `origin`, `source`); `total_matches` is a number equal to
     `results.length`; `cursor` is `null`. Assert at least one record has
     `source: "staged"` (contract §5) and title/summary respect the 120/200
     budgets.
   - `get_memory`: `memory` conforms; `relations` and `references` are arrays.
   - `get_context`: `records` is a non-empty array; the first record's `type` is
     `constraint` or `domain_rule` (priority ordering, contract §2); at least one
     record has `stale: true`; no record has `source: "staged"`.
3. **Tool registration/wiring** (`tests/mcp/registration.test.ts`) — connect an
   SDK `Client` to `createMcpServer()` over `InMemoryTransport`, call
   `tools/list`, and assert exactly the three read tools are registered with the
   expected names and non-empty input schemas. This guards against a handler
   existing but never being registered.

Shape assertions are written against the exported contract types (compile-time)
plus explicit runtime key/type checks (Vitest), so a future reshape breaks a
test rather than silently drifting from `lpms_facade_contract_v1.md`.

Out of scope for this change's tests: persistence, auth/RBAC decisions, staging
writes, real ranking/search, and error-path behavior beyond the opacity
convention being present (error-path tests land with change B/C when handlers
can actually throw domain errors).
