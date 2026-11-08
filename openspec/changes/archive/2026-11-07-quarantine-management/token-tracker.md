# Token Tracker: quarantine-management

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-08

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore | claude-haiku-5-5 / haiku | 108,279 | 25 | 85s | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | 237,058 | 40 | 746s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 1.1,2.1,2.2,2.3,3.1,3.2,4.1,4.2,4.3,5.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 392,627 | 156 | 1822s | all |
| verify | crombie-reviewer-high | claude-sonnet-5-5 / sonnet | 142,816 | 41 | 179s | — |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | [unavailable] | [unavailable] | [unavailable] | — |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | 123,412 | 36 | 199s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 6.1 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 108,279 |
| design | 237,058 (partial) |
| apply | 392,627 (partial) |
| verify | 266,228 (partial) |
| **Sub-agent total** | 1,004,192 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 1,004,192 (sub-agents only; orchestrator [unavailable]) |
