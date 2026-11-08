# Token Tracker: direct-memory-management

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| design | crombie-architect-high | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | 257,010 | 34 | 705s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | all |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 383,989 | 141 | 1726s | all |
| verify | crombie-reviewer | claude-sonnet-5-5 / sonnet | 83,640 | 25 | 55s | — |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | — |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | 107,453 | 30 | 93s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 6.1 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| design | 257,010 (partial) |
| apply | 383,989 (partial) |
| verify | 191,093 (partial) |
| **Sub-agent total** | 832,092 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 832,092 (sub-agents only; orchestrator [unavailable]) |
