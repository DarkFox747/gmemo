# Archive Report — hybrid-search (two-phase: lexical-first, semantic fallback)

schema: archive-report-v1
change: hybrid-search
status: CLOSED
verdict: PASS
archived_at: 2026-07-31

## Outcome
`recall` gains a semantic signal WITHOUT putting an embedding call on the hot path. Two-phase, first
page only: Phase 1 = the existing BM25 + time-decay recall (UNCHANGED); if it returns fewer than N
(`SEMANTIC_FALLBACK_MIN_RESULTS`, default 5) results, Phase 2 embeds the query (Bedrock Titan v2, via an
injectable seam) and runs a pure vector NN search (HNSW), appending deduped semantic hits after the BM25
rows. The common case makes ZERO embedding calls; only weak-lexical queries pay for one — and both the
query-embed and the vector call are fail-soft (degrade to BM25, never 500). Real Bedrock is DEFERRED behind
the seam (deterministic `StubEmbedder` for local/test; `BedrockEmbedder` skeleton throws). No new dependency.

## Pipeline
explore (2) → proposal → design (architect) → **[user pivot: fusion-always → two-phase]** → proposal/design/
specs/tasks revised → apply (4 batches A–D, 9 worker dispatches) → verify (security + reviewer) →
remediation (1 worker: H1+M1+L1+L2) → archive (inline).

## Design decisions (final)
- **Two-phase (lexical-first)** over fusion-always — the common query costs nothing; the HNSW index is
  actually used (Phase-2 ANN); the existing BM25 `recall` SQL/cursor/COUNT stay UNCHANGED (additive `recallSemantic`).
- Trigger = first-page `total_matches < N`. Semantic hits are first-page-only extras (mirror staging-mix);
  order staged → BM25 → semantic; `total_matches` = BM25 count.
- Embeddings **Bedrock Titan Text Embeddings V2 → `vector(1024)`** (`EMBEDDING_DIM` single source of truth; hard lock-in).
  Written at promotion time (fail-soft → NULL, never blocks); memories with NULL embedding stay BM25-searchable.
- `BedrockEmbedder.embed` THROWS (no fabricated vector); fail-soft lives in callers (write + read).
- HNSW partial index `WHERE embedding IS NOT NULL`, `vector_cosine_ops`; migration header documents the
  rds_superuser + non-CONCURRENTLY (per-file txn) + dim-lock caveats.

## Requirements
REQ-01..REQ-22 satisfied. 416 tests green (89 DB-gated integration skipped without `DATABASE_URL`); build + lint clean.

## Security (audited + remediated, holds)
0 CRITICAL / 0 HIGH. Fixed at verify: Phase-2 fail-soft wrap (M1), integration-test type safety (H1),
non-finite vector guard (L1), config `.min(1)` (L2). Clean: all vectors/excludeIds bound (no injection),
tenant-scoped `recallSemantic`, existing recall untouched, prod stub impossible (double-guarded), no PII in logs.

## Deferred → backlog
- Real `BedrockEmbedder.invokeModel` (VPC PrivateLink + IAM + model access; out-of-band `pnpm add @aws-sdk/*`).
  **NOTE: until this lands, semantic search runs on the deterministic non-semantic StubEmbedder — the rails
  work but real semantic quality needs the real embedder.**
- Query-embedding cache; backfill of pre-0005 rows; `CREATE INDEX CONCURRENTLY` / live-table migration +
  rds_superuser grant (ops); paginating semantic hits; weighted-score fusion / true RRF; score-threshold trigger.

## Accepted trade-offs
- Two-phase means a weak-lexical query does 2 passes (BM25 + vector) — the rare case; the common case is cheaper than fusion-always.
- `total_matches` counts BM25 only; semantic hits are additive extras (documented).

## Human follow-up
Wire the real Bedrock embedder (deferred) to get actual semantic results; run the DB-gated
`tests/integration/hybridSearch.int.test.ts` against a Postgres with the `vector` extension.
