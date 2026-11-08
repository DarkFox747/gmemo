# Token Tracker: demo-kit

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| apply | crombie-worker-opus-c5fix-carryover | [unavailable] | 228,752 | 90 | 1116s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | all |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 257,052 | 90 | 1374s | all |
| verify | crombie-reviewer | claude-sonnet-5-5 / sonnet | 42,141 | 15 | 44s | — |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 33,123 | 12 | 80s | 5.1,5.2 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| apply | 518,927 (partial) |
| verify | 42,141 |
| **Sub-agent total** | 561,068 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 561,068 (sub-agents only; orchestrator [unavailable]) |
