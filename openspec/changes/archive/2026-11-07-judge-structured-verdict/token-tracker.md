# Token Tracker: judge-structured-verdict

> Best-effort record of token usage for this SDD run. Missing data renders as
> `[unavailable]` and NEVER blocks the flow. Sub-agent tokens come from each Task
> completion notification's `usage` block; the orchestrator total is parsed post-hoc from
> the local session transcript JSONL (`[unavailable]` on failure).

**Status**: complete
**Generated**: 2026-11-07

## Per-agent / per-phase

| Phase | Agent | Model / Tier | Tokens | Tool uses | Duration | Tasks covered |
|-------|-------|--------------|--------|-----------|----------|---------------|
| explore | crombie-explore-high | claude-haiku-5-5 / haiku | 159,187 | 41 | 163s | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | — |
| design | crombie-architect-high | claude-opus-5-5 / opus | 190,007 | 70 | 761s | — |
| apply | crombie-worker-high | claude-sonnet-5-5 / sonnet | 89,423 | 26 | 230s | 1.3 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 126,426 | 38 | 278s | 1.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 115,221 | 28 | 363s | 1.2 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 80,537 | 36 | 125s | 2.1 |
| apply | crombie-worker | claude-sonnet-5-5 / sonnet | 42,889 | 10 | 56s | 3.2,3.3 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 179,220 | 42 | 584s | 3.1 |
| verify | crombie-reviewer-high | claude-sonnet-5-5 / sonnet | 130,464 | 29 | 137s | — |
| verify | crombie-worker | claude-sonnet-5-5 / sonnet | 36,001 | 12 | 149s | 4.1 |
| verify | crombie-security-high | claude-sonnet-5-5 / sonnet | 127,522 | 27 | 164s | — |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | [unavailable] | [unavailable] | [unavailable] | 5.1 |
| apply | crombie-worker-opus | claude-opus-5-5 / opus | 183,092 | 97 | 822s | 5.1 |

## Orchestrator

| Scope | Model / Tier | Tokens (in / out) | Notes |
|-------|---------------|--------------------|-------|
| whole feature | [unavailable] | [unavailable] | Session transcript could not be located or parsed. |

## Aggregate

| Phase | Tokens |
|-------|--------|
| explore | 159,187 |
| design | 190,007 (partial) |
| apply | 816,808 (partial) |
| verify | 293,987 |
| **Sub-agent total** | 1,459,989 (partial) |
| **Orchestrator total** | [unavailable] |
| **Grand total** | 1,459,989 (sub-agents only; orchestrator [unavailable]) |
