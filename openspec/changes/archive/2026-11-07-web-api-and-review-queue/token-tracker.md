# Token Tracker: web-api-and-review-queue

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore-medium | claude-haiku-5-5 / haiku | 145,076 | 43 | 92s | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | 218,495 | 57 | 739s | — |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 82,868 | 21 | 162s | 1.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 122,825 | 44 | 396s | 2.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 2.2 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 166,888 | 47 | 676s | 2.2 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 3.2 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 98,372 | 34 | 420s | 3.2 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | 3.1 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 96,122 | 41 | 454s | 3.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 4.1,5.1,5.2 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 176,408 | 56 | 610s | 4.1,5.1,5.2 |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | 138,592 | 36 | 161s | — |
| verify | crombie-reviewer-high | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | — |
| verify | crombie-reviewer-high | claude-sonnet-5-5 / sonnet | 155,414 | 50 | 184s | — |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | 7.1 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 98,946 | 32 | 277s | 7.1 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 145,076 |
| design | 218,495 |
| apply | 842,429 (partial) |
| verify | 294,006 (partial) |
| **Sub-agent total** | 1,500,006 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 1,500,006 (sub-agents only; orchestrator [unavailable]) |
