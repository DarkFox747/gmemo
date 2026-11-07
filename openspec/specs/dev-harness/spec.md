# Dev Harness Specification

## Purpose

Anyone with Docker can boot the full stubbed gmemo stack locally with no AWS account and verify it with a single smoke command, while the real Postgres, RBAC and audit path stays exercised. Every dev stub is impossible in production; the guards live in the spec of the seam they protect: `AUTH_DEV_BYPASS` in `auth`, `JUDGE_STUB` and `PROMOTE_OIDC_DEV_BYPASS` in `promotion`, `EMBEDDER_STUB` in `hybrid-search`, `RATE_LIMIT_ENABLED=false` in `http-security`.

## Requirements

### Requirement: Dev authenticator seam

A `DevAuthenticator` MUST implement the `Authenticator` seam and return a fixed `Principal` (scope `gmemo.memory/read`) whose `subject` equals the seeded `app_user.idp_subject`, without contacting Cognito. `RdsTenantResolver`, `RdsAuthorizer` and `RdsAuditLogger` MUST run unchanged against the local Postgres. Dev vs Cognito selection MUST live only in `src/index.ts` boot DI driven by config, and a unit test MUST assert the fixed principal.

Source: dev-harness

#### Scenario: Real Gate 2 under the bypass

- GIVEN the dev bypass is active
- WHEN calling a read tool
- THEN Gate 2, RBAC and audit run against the local Postgres

### Requirement: Dev seed data

`migrations/seed.dev.sql` MUST insert, honoring FKs, enums and CHECK budgets: one `project` (`gmemo`), one `repo` with a known `remote_url` (`https://github.com/crombie-llc/gmemo-demo.git`), one `app_user` (idp_subject = dev principal), one `project_membership` with the `contributor` role (so the write tools work), and several `memory` rows (at least one each of constraint, domain_rule, decision, gotcha). The seed MUST be applied dev-only (compose step or `NODE_ENV`-guarded script), MUST NOT be part of the production migrate path, and MUST be idempotent (`ON CONFLICT DO NOTHING`). The promotion demo rows are specified in `promotion`.

Source: dev-harness

#### Scenario: Repeatable seed

- GIVEN a seeded database
- WHEN the seed runs again
- THEN it succeeds without duplicates

#### Scenario: Seed refused in production

- GIVEN `NODE_ENV=production`
- WHEN the seed script runs
- THEN it refuses to run

### Requirement: Container image

A multi-stage `Dockerfile` MUST build with pnpm via corepack (frozen-lockfile install plus `pnpm build`) and run `node dist/index.js` as a non-root user, using pnpm only (no npm or bun). No secrets SHALL be baked in and `.env*` MUST NOT be copied. A `.dockerignore` MUST exclude node_modules, dist, .git, tests, docs, openspec and `.env*`.

Source: dev-harness

#### Scenario: Non-root runtime

- GIVEN the built image
- WHEN the container runs
- THEN the process user is not root

### Requirement: Compose stack

`docker-compose.yml` MUST define `db` (pgvector Postgres 16 image, healthcheck, named volume) and the app, apply migrations and seed before the app serves, wire `DATABASE_URL`, `NODE_ENV=development` and the stub flags inline, map the app port and healthcheck `/health`. The app MUST wait for the db to be healthy. Compose does not read `.env.dev.example`.

Source: dev-harness

#### Scenario: Ordered startup

- GIVEN `docker compose up`
- WHEN services start
- THEN `app` starts only after `db` is healthy and `migrate` completed

### Requirement: Dev env and run docs

`.env.dev.example` MUST document `DATABASE_URL`, `AUTH_DEV_BYPASS`, `NODE_ENV`, `PORT`, the stub flags and the exact `X-Git-Remote` value matching the seeded repo. A "run in 2 commands" section MUST show `docker compose up`, `GET /health` and a sample `POST /mcp` `recall` or `get_context` call including `X-Git-Remote`.

Source: dev-harness

#### Scenario: Documented call works

- GIVEN the running stack
- WHEN issuing the documented `recall` call
- THEN it returns seeded memory

### Requirement: Compose boots from scratch

`docker compose down -v && docker compose up --build` MUST bring up `db` (Postgres 16 with pgvector), run `migrate` to completion (all numbered migrations plus the dev seed) and leave `app` healthy on port 3000. No AWS credentials or `.env` file are needed. The `app` service SHALL run with every dev stub enabled: `AUTH_DEV_BYPASS`, `JUDGE_STUB=true` (deterministic judge with heuristic rules and default `JUDGE_STUB_CONFIDENCE` 0.9; `JUDGE_STUB_VERDICT` no longer exists), `PROMOTE_OIDC_DEV_BYPASS` and `EMBEDDER_STUB`.

Source: demo-baseline, judge-structured-verdict

#### Scenario: Clean boot

- GIVEN Docker is running and no gmemo volumes exist
- WHEN running `docker compose up --build`
- THEN `migrate` exits 0, including migration `0005` (`CREATE EXTENSION vector`), and `app` reports healthy

#### Scenario: Smoke item still promotes

- GIVEN a fresh compose stack
- WHEN `pnpm smoke` runs
- THEN the smoke `gotcha` matches the deterministic judge's default rule (accepted, 0.9 >= threshold) and is applied, and the run exits 0

#### Scenario: Missing stub is caught by config, not by a silent fallback

- GIVEN `EMBEDDER_STUB` is unset and no Bedrock embedding config is provided
- WHEN the app starts
- THEN configuration validation fails with an explicit error and a non-zero exit

### Requirement: Smoke test

`pnpm smoke` SHALL exercise the running stack and exit 0 only if every check passes. It MUST print each step and exit non-zero on the first failure. The base URL is configurable (default `http://localhost:3000`).

Source: demo-baseline

#### Scenario: Full happy path

- GIVEN the compose stack is freshly booted
- WHEN running `pnpm smoke`
- THEN, in order: `GET /health` returns 200 with `status: ok`, MCP `initialize` succeeds with server name `gmemo`, `recall` returns active seeded memories, `remember` stages a new item, `list_staged` includes it, `POST /promote` for the seeded repo and default branch returns a promotion outcome, and a second identical `POST /promote` reports no new work
- AND the process exits 0

#### Scenario: Stack down

- GIVEN nothing listens on the base URL
- WHEN running `pnpm smoke`
- THEN it reports the failing step and exits non-zero

### Requirement: Workspace layout

The repository SHALL be a pnpm workspace that includes `packages/*`, with the server at the root and a web package `@gmemo/web` under `packages/web`. The frozen-lockfile install MUST succeed on the host and inside the Docker build. The server image SHALL NOT include web sources.

Source: demo-baseline

#### Scenario: Frozen install in Docker

- GIVEN the committed `pnpm-lock.yaml` and `pnpm-workspace.yaml`
- WHEN the Docker image is built
- THEN the frozen install succeeds and the image runs `node dist/index.js`

### Requirement: Dev bypasses impossible in production

Every dev bypass or stub (`AUTH_DEV_BYPASS`, `JUDGE_STUB`, `PROMOTE_OIDC_DEV_BYPASS`, `EMBEDDER_STUB`, `RATE_LIMIT_ENABLED=false`) MUST be rejected at startup when `NODE_ENV=production`, and each SHALL have an automated test.

Source: demo-baseline

#### Scenario: Rate limit cannot be disabled in production

- GIVEN `NODE_ENV=production` and `RATE_LIMIT_ENABLED=false`
- WHEN configuration is loaded
- THEN loading fails with an explicit error and the process exits non-zero

## History

| Requirement | Source | Superseded by |
|---|---|---|
| Compose `db` uses plain `postgres:16` | dev-harness | demo-baseline (pgvector image, required by migration 0005) |
| Compose app sets only `DATABASE_URL`, `AUTH_DEV_BYPASS`, `NODE_ENV` | dev-harness | demo-baseline (all stubs including `EMBEDDER_STUB` and `JUDGE_STUB`) |
| Seed membership role is viewer or higher | dev-harness | demo-baseline (seeded as `contributor` for the smoke test's write steps) |
| Compose app sets `JUDGE_STUB_VERDICT=accepted` (constant verdict) | demo-baseline | judge-structured-verdict (deterministic heuristic judge, `JUDGE_STUB_CONFIDENCE`) |
