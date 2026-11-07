# Delta for dev-harness (new requirements; consolidated main spec created in this change)

## Purpose

Anyone with Docker can boot the full stubbed gmemo stack locally with no AWS account, and can verify it with a single smoke command. Dev stubs stay impossible in production.

## Requirements

### Requirement: Compose boots from scratch

`docker compose down -v && docker compose up --build` MUST bring up `db` (Postgres 16 with pgvector), run `migrate` to completion (all numbered migrations plus the dev seed), and leave `app` healthy on port 3000. No AWS credentials or `.env` file are needed. The `app` service SHALL run with every dev stub enabled: `AUTH_DEV_BYPASS`, `JUDGE_STUB` (verdict `accepted`), `PROMOTE_OIDC_DEV_BYPASS` and `EMBEDDER_STUB`.

#### Scenario: Clean boot

- GIVEN Docker is running and no gmemo volumes exist
- WHEN running `docker compose up --build`
- THEN `migrate` exits 0, including migration `0005` (`CREATE EXTENSION vector`), and `app` reports healthy

#### Scenario: Missing stub is caught by config, not by a silent fallback

- GIVEN `EMBEDDER_STUB` is unset and no Bedrock embedding config is provided
- WHEN the app starts
- THEN configuration validation fails with an explicit error and a non-zero exit

### Requirement: Smoke test

`pnpm smoke` SHALL exercise the running stack and exit 0 only if every check passes. It MUST print each step and exit non-zero on the first failure. The base URL is configurable (default `http://localhost:3000`).

#### Scenario: Full happy path

- GIVEN the compose stack is freshly booted
- WHEN running `pnpm smoke`
- THEN, in order:
  - `GET /health` returns 200 with `status: ok`
  - MCP `initialize` succeeds with server name `gmemo`
  - `recall` returns active seeded memories
  - `remember` stages a new item
  - `list_staged` includes the new item
  - `POST /promote` for the seeded repo and default branch returns a promotion outcome
  - a second identical `POST /promote` reports no new work (idempotency)
- AND the process exits 0

#### Scenario: Stack down

- GIVEN nothing listens on the base URL
- WHEN running `pnpm smoke`
- THEN it reports the failing step and exits non-zero

### Requirement: Workspace layout

The repository SHALL be a pnpm workspace that includes `packages/*`, with the server remaining at the root and a web package `@gmemo/web` under `packages/web`. `pnpm install --frozen-lockfile` MUST succeed on the host and inside the Docker build. The server image SHALL NOT include web sources.

#### Scenario: Frozen install in Docker

- GIVEN the committed `pnpm-lock.yaml` and `pnpm-workspace.yaml`
- WHEN the Docker image is built
- THEN the frozen install succeeds and the image runs `node dist/index.js`

### Requirement: Dev bypasses impossible in production

Every dev bypass or stub (`AUTH_DEV_BYPASS`, `JUDGE_STUB`, `PROMOTE_OIDC_DEV_BYPASS`, `EMBEDDER_STUB`, `RATE_LIMIT_ENABLED=false`) MUST be rejected at startup when `NODE_ENV=production`. Each one SHALL have an automated test.

#### Scenario: Rate limit cannot be disabled in production

- GIVEN `NODE_ENV=production` and `RATE_LIMIT_ENABLED=false`
- WHEN configuration is loaded
- THEN loading fails with an explicit error and the process exits non-zero
