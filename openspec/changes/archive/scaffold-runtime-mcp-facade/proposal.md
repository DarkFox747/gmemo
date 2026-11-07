# Proposal — Scaffold Runtime + Minimal MCP Facade

schema: proposal-v1
change: scaffold-runtime-mcp-facade
status: draft
author: sdd-orchestrator

## Problem / Motivation

The LPMS Cloud design is closed (schema v2, facade contract v1) but there is **zero
runtime code** — no `package.json`, no test framework, no server. Every downstream
change (data model, auth, staging/promotion) needs a runtime and a facade to hang off.
This change lays the foundation: a minimal, running Node/Express + TypeScript service
that exposes the MCP facade **read tools as typed stubs**, plus a test harness. It also
unblocks `sdd-init`'s TDD mode (currently disabled for lack of a test framework).

## Goal

A `pnpm install && pnpm test && pnpm dev`-ready service that:
- boots an Express app with a `/health` endpoint,
- registers an MCP server exposing `recall`, `get_memory`, `get_context` as **stubs**
  that return well-typed, contract-shaped placeholder responses,
- has a green test suite (framework wired, first tests passing),
- follows the conventions already recorded in `openspec/project-map.yaml`.

## Chosen Approach

Minimal vertical slice, **no persistence and no auth yet** (YAGNI — those are separate
changes B and C). Use the official MCP TypeScript SDK for the facade so tool
registration follows the protocol correctly. Express for HTTP (matches the design's
pilot runtime). Vitest for tests (fast, TS-native, zero extra config).

Tool stubs return the **exact response shapes** from the facade contract v1 so that
change B (data model) and beyond only have to fill in the implementation, not reshape
the interface. Tenant resolution, RBAC, and real search are explicitly out of scope and
left as clearly-marked `TODO(change-B/C)` seams.

## Scope

### IN scope
- `package.json`, `tsconfig.json`, lint/format config aligned to project conventions.
- Express app + `/health`.
- MCP server registration exposing read-tool **stubs**: `recall`, `get_memory`, `get_context`.
- Typed contract models (request/response) for those three tools, matching contract v1.
- Vitest setup + first passing tests (health endpoint + each stub's shape).
- Directory structure reflecting the intended modules from `project-map.yaml`.
- README/run instructions for the service.

### OUT of scope (explicitly deferred)
- Database / RDS / migrations → **change B**.
- Auth (Cognito JWT, two-gate, RBAC) → **change C**.
- Write-to-staging tools (`remember`, `list_staged`, `discard_staged`) and promotion.
- Graph tools (Layer 2) and any CI wiring.
- Real hybrid search (BM25 / pgvector), judge, quarantine.
- Any AWS infra / deployment.

## Affected Areas

| Area | What changes | New/Modified |
|------|--------------|--------------|
| Runtime scaffold | package.json, tsconfig, Express bootstrap, config loader, `/health` | New |
| MCP facade skeleton | MCP server registration + 3 read-tool stubs + typed contract models | New |
| Testing harness | Vitest config + first passing tests | New |

_3 affected areas → simple change._

## Constraints (from design)

- Error opacity: no tenant/resource enumeration in errors; generic denials only.
- Stateless compute: no in-memory session state (all future state goes to RDS).
- Response shapes must match `docs/artefactos/lpms_facade_contract_v1.md` exactly.
- All identifiers/strings/content in English.
- Keep the tenant-resolution and RBAC points as explicit seams (do not fake them).

## Open Decisions Touched

- **Test framework choice** — proposing **Vitest** (resolves the `sdd-init` TDD blocker).
- Does NOT touch any pilot-blocking design decision (FTS dict, quarantine retention,
  provisioning, AgentCore SSE) — those are out of this slice.

## Rejected Alternatives

- **NestJS** instead of Express — heavier, introduces DI/decorator conventions not in the
  design; the docs name Express for the pilot. Rejected (YAGNI).
- **Jest** instead of Vitest — works, but slower on TS and needs more config. Vitest is
  lighter for a fresh TS project.
- **Implementing real tool logic now** — rejected; violates the single-write-path and
  layering boundaries and duplicates work that belongs to changes B/C.

## Risks

- MCP TS SDK is a new runtime dependency — justified: it is the protocol the whole facade
  is built on; hand-rolling it would be a mis-abstraction.
- Stubs risk drifting from contract v1 — mitigated by deriving the typed models directly
  from the contract doc and testing each stub's response shape.

## Next Phases

specs + design (parallel) → tasks → apply → verify → archive.
