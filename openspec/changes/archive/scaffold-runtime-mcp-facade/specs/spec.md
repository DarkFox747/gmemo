# Spec — Scaffold Runtime + Minimal MCP Facade

schema: spec-v1
change: scaffold-runtime-mcp-facade
status: draft

## Overview

Foundational vertical slice for LPMS Cloud: a running Node.js + Express + TypeScript
service that exposes the MCP facade READ tools as typed stubs and ships a green Vitest
suite. No persistence, auth, write path, graph, or infra (deferred to later changes).

## Requirements

### Runtime & Build
- **REQ-01** The project MUST have a `package.json` with scripts: `dev`, `build`, `start`, `test`, `lint`.
- **REQ-02** The project MUST compile under TypeScript strict mode (`"strict": true`) with no type errors.
- **REQ-03** `pnpm install` (or the chosen package manager) MUST succeed with only the dependencies justified in the design (MCP TS SDK, Express, Vitest, TypeScript, a TS runner). No unused deps.
- **REQ-04** Directory layout under `src/` MUST reflect the intended module boundaries from `project-map.yaml` (a `facade-mcp` area at minimum), keeping only in-scope parts.

### HTTP Service
- **REQ-05** An Express app MUST boot and expose `GET /health` returning HTTP 200 with a JSON body indicating service status (e.g. `{ "status": "ok" }`).
- **REQ-06** The service MUST NOT hold in-memory session/tenant state (stateless compute constraint).
- **REQ-07** Configuration (e.g. port) MUST be read from environment with safe defaults; no secrets committed. `.env.example` MAY document variables.

### MCP Facade (read tools, stubbed)
- **REQ-08** An MCP server MUST be registered exposing exactly three tools: `recall`, `get_memory`, `get_context`. No write/staging or graph tools in this change.
- **REQ-09** Each tool MUST have TypeScript request and response types matching the shapes in `docs/artefactos/lpms_facade_contract_v1.md` exactly.
- **REQ-10** Each tool handler MUST be a STUB returning contract-shaped placeholder data (well-typed), not real logic.
- **REQ-11** Tenant resolution (project/session/repo from token + git remote) MUST be present as an explicit, clearly-marked seam/TODO — NOT faked with fabricated tenant data. Reserved for change B.
- **REQ-12** RBAC/authorization MUST be present as an explicit, clearly-marked seam/TODO — NOT enforced or faked. Reserved for change C.

### Error Handling
- **REQ-13** Error responses MUST follow error-opacity: generic denial messages, no tenant/resource enumeration, no stack traces or secrets leaked to the client.

### Testing
- **REQ-14** Vitest MUST be configured and `pnpm test` MUST run green.
- **REQ-15** There MUST be a passing test asserting `GET /health` returns 200 with the expected body.
- **REQ-16** There MUST be a passing test per read tool asserting the stub's response conforms to the contract-defined response shape.

### Documentation
- **REQ-17** A short run guide (README section or CONTRIBUTING) MUST document install / dev / test commands.

## Acceptance Criteria

- `pnpm install && pnpm build && pnpm test` all succeed from a clean checkout.
- `pnpm dev` boots the service; `GET /health` returns 200 `{ "status": "ok" }`.
- The MCP server lists exactly `recall`, `get_memory`, `get_context`; invoking each returns a response matching contract v1 shape.
- Tenant-resolution and RBAC seams are visible in code as marked TODOs with intended interfaces, not stubbed with fake data.
- No database, auth provider, AWS SDK, or write-path code is present.
- TDD mode can be enabled in `sdd-init` afterward (a test framework now exists).

## Out of Scope (traceability)

DB/migrations (change B) · Cognito/two-gate auth + RBAC enforcement (change C) ·
`remember`/`list_staged`/`discard_staged` + promotion · graph Layer 2 tools · real hybrid
search / judge / quarantine · AWS infra & deployment.
