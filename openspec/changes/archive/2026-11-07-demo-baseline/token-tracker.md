# Token Tracker: demo-baseline

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-07

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore-medium | claude-haiku-5-5 / haiku | 146,889 | 31 | 171s | — |
| explore | crombie-explore-medium | claude-haiku-5-5 / haiku | 134,743 | 54 | 134s | — |
| design | crombie-architect | claude-opus-5-5 / opus | 154,940 | 49 | 420s | — |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 27,432 | 7 | 63s | 2.1,2.2,2.3,2.4,3.1 |
| apply | crombie-worker-low | claude-sonnet-5-5 / sonnet | 21,316 | 4 | 15s | 4.5 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 32,713 | 8 | 47s | 4.6,4.7 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 32,756 | 11 | 178s | 4.1,4.2,4.3,4.4 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 37,552 | 14 | 45s | 6.1 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 55,865 | 29 | 73s | 5.1,5.2 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 101,639 | 21 | 225s | 6.2 |
| apply | crombie-worker-high | claude-sonnet-5-5 / sonnet | 23,740 | 6 | 31s | 4.4,5.1,5.2 |
| apply | crombie-worker-high | claude-sonnet-5-5 / sonnet | 72,862 | 41 | 643s | 4.4,5.1,5.2 |
| verify | crombie-security | claude-sonnet-5-5 / sonnet | 49,859 | 24 | 46s | — |
| verify | crombie-reviewer | claude-sonnet-5-5 / sonnet | 36,844 | 8 | 69s | — |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 48,596 | 20 | 568s | 5.3 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 281,632 |
| design | 154,940 |
| apply | 454,471 |
| verify | 86,703 |
| **Sub-agent total** | 977,746 |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 977,746 (sub-agents only; orchestrator [unavailable]) |
