# Demo Kit Specification

## Purpose

Make the gmemo demo reproducible from scratch for the TFG: seed data, an end-to-end script that is also a test, synthetic metrics, instructions and a sanitized package.

## Requirements

### Requirement: Demo seed

Source: demo-kit

The development seed SHALL create the "Portal de Clientes" project with two repositories, the three demo users and a service-agent credential, about 15 active memories of all seven types with history, two memories past their revalidation deadline, two uncertain and two mandatory-review queue items, and one quarantine entry per reason code. It MUST be refused outside development and be idempotent.

#### Scenario: Fresh stack has demo data
- GIVEN `docker compose down -v && docker compose up --build`
- WHEN the tech lead opens the review queue and quarantine
- THEN the queue shows 4 pending items (2 uncertain, 2 mandatory) and the quarantine shows one entry per reason

### Requirement: End-to-end demo script

Source: demo-kit

`pnpm demo` SHALL drive the full cycle against the running stack (capture with a rejected credential, staged drafts in recall, promotion summary, queue approval superseding the old decision, quarantine restore, revalidation job, final recall), print each step legibly, and exit 0 only if every expectation holds.

#### Scenario: Superseded and pending are not recalled
- GIVEN the script ran its approval and the revalidation job
- WHEN the final recall runs
- THEN the newly approved decision appears and neither the superseded decision nor the expired memories appear

### Requirement: Synthetic metrics (TT-06)

Source: demo-kit

`pnpm eval` SHALL compute recall@5, MRR and nDCG@5 for recall and the judge's false-positive and false-negative rates over versioned synthetic fixtures, and write `docs/demo/metricas.md` stating that the data is synthetic and the judge and embedder are stubs.

#### Scenario: Deterministic metrics
- GIVEN the same fixtures
- WHEN `pnpm eval` runs twice
- THEN both runs produce identical numbers

### Requirement: Instructions and package

Source: demo-kit

`docs/demo/INSTRUCTIVO.md` SHALL explain the demo in Spanish (requirements, two-command start, URLs, dev users and role switching, script, real agent, tests and metrics, HU mapping, simplifications, troubleshooting). `scripts/package-demo.sh` SHALL produce `dist-demo/gmemo-demo.zip` without dependencies, VCS, tooling, personal material or secrets, and verify it with the sanitization grep.

#### Scenario: Clean package
- GIVEN the zip is generated
- WHEN it is unzipped and searched with the sanitization patterns and for `.claude`, `.mcp.json`, `node_modules` and `.env`
- THEN nothing is found

## History

None.
