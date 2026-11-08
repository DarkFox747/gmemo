# Archive Report: hybrid-search-rrf

**Archived**: 2026-11-07 | **Branch**: demo/e4 | **Final verdict**: PASS

## Shipped
- `recall` fuses lexical (BM25 + time-decay) and semantic (pgvector) top-50 lists with Reciprocal Rank Fusion (k=60); limit 5 by default, max 8; repo priority; offset cursor; fail-soft lexical only
- `SEMANTIC_FALLBACK_*` removed; contract and docs updated

## Specs synced
| Domain | Action | Details |
|--------|--------|---------|
| hybrid-search | Updated | +4 requirements, 2 replaced (history rows) |

## Retro
Retro skipped: auto mode, best-effort.

## Follow-ups
Real-DB test for repo priority; real semantic quality needs the Bedrock embedder (the demo uses the stub).
