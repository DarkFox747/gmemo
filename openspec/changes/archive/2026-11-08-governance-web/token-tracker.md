# Token Tracker: governance-web

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: partial (through verify)
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| design | crombie-architect | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | — |
| design | crombie-architect | claude-opus-5-5 / opus | 138,674 | 38 | 404s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | all |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 375,745 | 175 | 2221s | all |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | — |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | 109,382 | 49 | 121s | — |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| design | 138,674 (partial) |
| apply | 375,745 (partial) |
| verify | 109,382 (partial) |
| **Sub-agent total** | 623,801 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 623,801 (sub-agents only; orchestrator [unavailable]) |
