# Token Tracker: hybrid-search-rrf

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore | claude-haiku-5-5 / haiku | 84,141 | 35 | 49s | — |
| apply | crombie-worker-high | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | all |
| apply | crombie-worker-high | claude-sonnet-5-5 / sonnet | 161,345 | 60 | 596s | all |
| verify | crombie-reviewer | claude-sonnet-5-5 / sonnet | 30,670 | 14 | 40s | — |
| apply | crombie-worker-low | claude-sonnet-5-5 / sonnet | 23,002 | 13 | 111s | 4.1 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 84,141 |
| apply | 184,347 (partial) |
| verify | 30,670 |
| **Sub-agent total** | 299,158 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 299,158 (sub-agents only; orchestrator [unavailable]) |
