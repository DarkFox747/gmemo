# Repository Hygiene Specification

## Purpose

Keep the gmemo repository publishable: no sensitive operational data, one consistent product name, no dead scaffolding, and an `openspec/specs/` baseline that reflects the system's current behavior.

## Requirements

### Requirement: No sensitive operational data in tracked files

Tracked files MUST NOT contain the AWS account ID, operator IP addresses, Route 53 hosted zone IDs, personal or work email addresses, real deployment domains, Terraform state bucket or lock table names, or ARNs that embed a literal 12-digit account ID. Each occurrence SHALL be replaced by a placeholder (`<AWS_ACCOUNT_ID>`, `<OPERATOR_IP>/32`, `<HOSTED_ZONE_ID>`, `<ADMIN_EMAIL>`, `<DOMAIN>`, `<GITHUB_ORG>/<REPO>`, `<TFSTATE_BUCKET>`, `<TFLOCK_TABLE>`, `<OIDC_ROLE_NAME>`, `<COMPANY_DOMAIN>`). ARNs built from Terraform variables (e.g. `${var.account_id}`) and AWS-managed policy ARNs MAY remain.

#### Scenario: Sanitization grep is empty

- GIVEN the working tree, excluding `.git/`, `node_modules/` and gitignored paths
- WHEN searching with the patterns in the local, gitignored `.sanitize-patterns` file (account ID, operator IP, hosted zone, company email domain, live domain and state bucket names, ARNs with a literal 12-digit account)
- THEN no match is found

#### Scenario: Templated ARNs survive

- GIVEN `terraform/cicd/main.tf` builds ARNs from `${var.account_id}`
- WHEN sanitization runs
- THEN those ARNs are unchanged and `terraform/cicd/variables.tf` no longer defaults `account_id` to a literal account

#### Scenario: Sanitization precedes history

- GIVEN the directory is not yet a git repository
- WHEN the first commit is created
- THEN the sanitization grep was empty before `git init`, so no commit in history contains a sensitive value

#### Scenario: Binary documents are checked

- GIVEN `docs/gmemo_Cloud_Diseno_v0.6.docx`
- WHEN its XML parts are searched with the sanitization pattern
- THEN either no match is found, or the match is reported to the human owner (binary content is not edited automatically)

### Requirement: Tooling and personal material are not tracked

The repository MUST ignore `.claude/`, `CLAUDE.md`, `.claude.json`, `.mcp.json`, `entrevistas/`, `prompt.md` and `PROMPT-demo-entrega4.md` (orchestrator tooling and personal material). These paths SHALL NOT be modified by this change.

#### Scenario: Excluded paths are untracked

- GIVEN the repository after the baseline commit
- WHEN running `git ls-files`
- THEN no path under `.claude/` or `entrevistas/` is listed, and neither are `.claude.json`, `.mcp.json`, `prompt.md` or `PROMPT-demo-entrega4.md`

### Requirement: Product is named gmemo

The product SHALL be identified as **gmemo** in code identifiers, package name, MCP server identity, container images, database names, dev seed, CI workflow variables (`GMEMO_*`), Terraform resource names, artefact file names and documentation. References to LPMS as the orchestrator's memory tool (e.g. `cache_store: lpms`, `lpms-convention`) or as the local predecessor product MUST be preserved. Archived SDD changes MUST NOT be rewritten for the rename.

#### Scenario: MCP server identity

- GIVEN the app is running
- WHEN an MCP client sends `initialize`
- THEN `serverInfo.name` is `gmemo`

#### Scenario: Package and seed

- GIVEN a fresh compose database
- WHEN the dev seed runs
- THEN the seeded repo remote is `https://github.com/crombie-llc/gmemo-demo.git`, and the root `package.json` name is `gmemo`

#### Scenario: Remaining lpms occurrences are intentional

- GIVEN the tracked tree outside `openspec/changes/archive/`
- WHEN searching case-insensitively for `lpms`
- THEN every match is either an orchestrator-memory-tool reference or predecessor wording

#### Scenario: Artefact references resolve

- GIVEN the renamed `docs/artefactos/gmemo_schema_v2.sql` and `docs/artefactos/gmemo_facade_contract_v1.md`
- WHEN searching tracked files (outside the archive) for `lpms_schema_v2` or `lpms_facade_contract_v1`
- THEN no match is found

### Requirement: No dead scaffolding

The repository MUST NOT contain the obsolete `packages/server` (Prisma scaffold), `packages/infra`, `infra/docker-compose.yml` or `tsconfig.base.json`. Developer documentation SHALL describe only the current stack (pnpm, Node 22, Express 5, `pg`, Vitest, docker compose).

#### Scenario: Docs match the toolchain

- GIVEN `DEVELOPMENT.md`
- WHEN reading its commands
- THEN every command uses `pnpm` or `docker compose` and refers to a script that exists in `package.json`, and Prisma is not mentioned

### Requirement: Main specs baseline

`openspec/specs/` SHALL contain one main spec per capability, consolidated from the archived changes' specs, so later changes can write deltas against them.

#### Scenario: Specs consolidated

- GIVEN the 12 archived changes with specs
- WHEN consolidation completes
- THEN each archived requirement appears in exactly one `openspec/specs/{domain}/spec.md`, and its source change is recorded
