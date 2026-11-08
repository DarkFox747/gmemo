# Proposal: CI test gate and security follow-ups

## Intent

No workflow runs the test suite (deploy.yml rolls ECS with no gate), which weakens a public, evaluated repo. Two declared follow-ups remain open (backlog E4 #2 and #3): the secret scanner misses OpenAI project keys (`sk-proj-…`), GitHub fine-grained PATs (`github_pat_…`) and AWS secret access keys; and REST API writes record their audit row outside the write transaction, so a committed write can exist without its audit row.

## Scope

### In Scope
- `.github/workflows/ci.yml`: on pull_request and push to main; Node 22 + corepack pnpm, `pnpm install --frozen-lockfile`, lint, build, typecheck:web, build:web, full test suite against a `pgvector/pgvector:pg16` service (`DATABASE_URL=postgres://gmemo:gmemo@localhost:5432/gmemo`). Actions pinned by SHA (checkout v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683`, setup-node v4.4.0 `49933ea5288caeca8642d1e84afbd3f7d6820020`), `permissions: contents: read`.
- Secret scan: new categories `openai_project_key` (`sk-proj-` / `sk-svcacct-` / `sk-admin-` style tokens), `github_fine_grained_pat` (`github_pat_`), `aws_secret_access_key` (40-char base64 value in an AWS-secret context: `aws_secret_access_key`, `aws_secret`, `secretAccessKey` keys); detection + span redaction ranges; fixtures built at runtime (no literal secrets in the repo).
- API write audit atomicity: the audit row for REST writes (review approve/reject, quarantine restore, memory create/amend/confirm/retire/retire-by-pr) is written in the same DB transaction as the write, or the write is rolled back (fail closed), following the existing `access_log` writer.

### Out of Scope
- Deploy gating on CI (deploy.yml unchanged), coverage thresholds, new secret categories beyond the three.

## Approach
CI: a single job mirroring the local full check. Scanner: extend `SECRET_PATTERNS` (pattern + range) like the existing entries. Audit: thread a transaction-scoped audit write through the services' existing transactional write path (applyOpInTxn / repository txns) instead of the post-commit `recordApi` call, keeping one audit row per action and the same row shape.

## Constraints
- No new dependencies; secure-by-default; no silent failures; the access_log row shape and actions unchanged.
- Fixture secrets must never appear literally (sanitize gate + push protection).

## Affected Areas
| Area / Module | Impact | Description |
|---|---|---|
| `.github/workflows` | New | ci.yml |
| `src/security` | Modified | 3 new secret categories |
| `src/auth` (audit) + API services/repositories | Modified | audit in the write transaction |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| AWS-secret heuristic false positives | Med | Context-anchored (key name required), 40-char exact |
| Refactor of audit path breaks API writes | Med | Integration tests: write + audit committed together; audit failure rolls back the write |

## Rollback Plan
Revert the change commit; no migration.

## Success Criteria
- [ ] ci.yml valid YAML, pinned actions, runs the same commands as the local full check.
- [ ] Scanner detects and redacts the three new categories; no false positive on existing benign fixtures.
- [ ] API writes and their audit rows commit atomically (DB test proves rollback on audit failure).
- [ ] Suite, lint, build green.
