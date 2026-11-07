# MCP Facade Specification

## Purpose

The gmemo service is a stateless Node.js + Express + TypeScript process that exposes the memory facade as MCP tools over Streamable HTTP, with opaque error handling and a green test suite. Tool behavior lives in the capability specs (`memory-read`, `staging`, `hybrid-search`); authentication in `auth`.

## Requirements

### Requirement: Runtime and build

The project MUST define `dev`, `build`, `start`, `test` and `lint` scripts, MUST compile under TypeScript strict mode without type errors, and MUST install only dependencies justified by the design. The `src/` layout MUST reflect the module boundaries in `project-map.yaml`.

Source: scaffold-runtime-mcp-facade

#### Scenario: Clean checkout

- GIVEN a clean checkout
- WHEN running the frozen-lockfile install, then `pnpm build` and `pnpm test`
- THEN all of them succeed

### Requirement: Health endpoint and stateless service

An Express app MUST expose `GET /health` returning HTTP 200 with `{ "status": "ok" }`. The service MUST NOT hold in-memory session or tenant state. Configuration (for example the port) MUST come from the environment with safe defaults, and no secrets SHALL be committed.

Source: scaffold-runtime-mcp-facade

#### Scenario: Health check

- GIVEN the service is running
- WHEN calling `GET /health`
- THEN it returns 200 with `{ "status": "ok" }`

### Requirement: Registered MCP tools

The MCP server MUST register the read tools `recall`, `get_memory` and `get_context` and the write tools `remember`, `list_staged` and `discard_staged`. No graph (Layer 2) tools SHALL be registered.

Source: scaffold-runtime-mcp-facade

#### Scenario: Tool listing

- GIVEN a connected MCP client
- WHEN listing tools
- THEN exactly the six tools above are returned

### Requirement: Contract-typed tool shapes

Each tool MUST have request and response TypeScript types matching `docs/artefactos/gmemo_facade_contract_v1.md` exactly.

Source: scaffold-runtime-mcp-facade

#### Scenario: Response conforms to contract

- GIVEN a tool invocation
- WHEN the handler responds
- THEN the response matches the contract-defined shape

### Requirement: Error opacity

Error responses MUST be generic: no tenant or resource enumeration, no stack traces, no secrets.

Source: scaffold-runtime-mcp-facade

#### Scenario: Denied call

- GIVEN a call that fails for any reason
- WHEN the error reaches the client
- THEN it contains only a generic message

### Requirement: Test suite and run guide

Vitest MUST be configured and `pnpm test` MUST run green, including a test for `GET /health` and one test per read tool asserting contract-shaped responses. A short run guide MUST document install, dev and test commands.

Source: scaffold-runtime-mcp-facade

#### Scenario: Suite green

- GIVEN the repository
- WHEN running `pnpm test`
- THEN it passes

## History

| Requirement | Source | Superseded by |
|---|---|---|
| Exactly three read tools registered, no write tools | scaffold-runtime-mcp-facade | write-path (adds `remember`, `list_staged`, `discard_staged`) |
| Tool handlers are contract-shaped stubs with placeholder data | scaffold-runtime-mcp-facade | data-model (real RDS-backed read tools; see `memory-read`) |
| Tenant resolution is a marked seam, not faked | scaffold-runtime-mcp-facade | auth-two-gate (real `TenantResolver`; see `auth`) |
| RBAC is a marked seam, not enforced | scaffold-runtime-mcp-facade | auth-two-gate (real `Authorizer`; see `auth`) |
