# Token Tracker: memory-lifecycle

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore | claude-haiku-5-5 / haiku | 87,212 | 26 | 42s | — |
| design | crombie-architect | claude-opus-5-5 / opus | 153,195 | 33 | 297s | — |
| apply | note-c3-fix-tokens | [unavailable] | [unavailable] | [unavailable] | [unavailable] | — |
| apply | crombie-worker-opus-c3fix | [unavailable] | 157,729 | 75 | 662s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | all |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 277,710 | 111 | 1220s | all |
| verify | crombie-security | claude-sonnet-5-5 / sonnet | 33,569 | 17 | 37s | — |
| verify | crombie-reviewer | claude-sonnet-5-5 / sonnet | 50,944 | 13 | 43s | — |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 87,212 |
| design | 153,195 |
| apply | 435,439 (partial) |
| verify | 84,513 |
| **Sub-agent total** | 760,359 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 760,359 (sub-agents only; orchestrator [unavailable]) |
