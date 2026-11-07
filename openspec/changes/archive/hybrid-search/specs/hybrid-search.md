# Spec — hybrid-search (two-phase: lexical-first, semantic fallback)

schema: spec-v1
change: hybrid-search
status: DRAFT
date: 2026-07-31
revised: 2026-07-31  # two-phase (was fusion-always)

Testable acceptance criteria. No new runtime dep. No real AWS. The existing BM25 `recall` is UNCHANGED.

## Migration 0005
- **REQ-01** `migrations/0005_embeddings.sql` (idempotent): `CREATE EXTENSION IF NOT EXISTS vector`;
  `memory.embedding vector(1024)` (nullable, `ADD COLUMN IF NOT EXISTS`); HNSW partial index
  `USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`.
- **REQ-02** Header documents the caveats: `rds_superuser` for the extension; no `CREATE INDEX CONCURRENTLY`
  (runner uses one txn/file); dim 1024 lock-in. (HNSW IS on the hot path here — Phase-2 NN.)

## Embedder seam
- **REQ-03** `src/embedder/embedder.ts` exports `EMBEDDING_DIM = 1024` + `Embedder` interface `embed(text): Promise<number[]>`.
- **REQ-04** `StubEmbedder`: deterministic (same input → identical vector), dependency-free (`node:crypto`),
  `EMBEDDING_DIM`-length L2-normalized; DEV/TEST only.
- **REQ-05** `BedrockEmbedder.embed` THROWS (deferred `invokeModel`); NO `@aws-sdk/*` import.
- **REQ-06** `src/db/vector.ts` `toVectorParam(vec|null)` → `'[...]'` literal or `null`.

## Config
- **REQ-07** `EMBEDDER_STUB` + `BEDROCK_EMBEDDING_MODEL_ID` (superRefine: stub prod-forbidden; model-id required
  when stub off) + composition-root `NODE_ENV!=='production'` double-check + WARN banner.
- **REQ-08** `SEMANTIC_FALLBACK_MIN_RESULTS` (N, default 5) and `SEMANTIC_FALLBACK_K` (vector hits, default 8)
  are config values (sane numeric defaults; validated).

## Write path (fail-soft)
- **REQ-09** `PromoteService.promote` computes the embedding (`title\nsummary\nbody`) for accepted
  add/amend/supersede BEFORE `applyAccepted`; `deprecate` never embeds.
- **REQ-10** A write-time embedding error → item written with `embedding = NULL` (+ warn); promotion STILL
  succeeds (never blocks/quarantines/500s).
- **REQ-11** `applyAccepted(item, ctx, embedding)` writes `embedding` via `$N::vector` on INSERT (add+supersede)
  and amend UPDATE; NULL binds SQL NULL. `content_tsv` still GENERATED (never in a column list). deprecate SQL unchanged.

## Read path — two-phase
- **REQ-12** Phase 1 is the EXISTING `memoryRepository.recall` — UNCHANGED (SQL, keyset cursor `{rank,id}`,
  params $1–$7, and the parallel COUNT all stay exactly as today).
- **REQ-13** `memoryRepository.recallSemantic(tenant, queryEmbedding, filters, excludeIds, k)` runs a pure
  vector NN search: `ORDER BY embedding <=> $qvec LIMIT k`, tenant-scoped (project_id), `status='active'`,
  `embedding IS NOT NULL`, same repo/type (scope) filters as recall, excluding `excludeIds` — parameterized.
- **REQ-14** The recall HANDLER runs Phase 2 ONLY when `cursor === null` AND Phase-1 `total_matches < N`
  (`SEMANTIC_FALLBACK_MIN_RESULTS`). On subsequent pages (cursor present) Phase 2 never runs.
- **REQ-15** Phase 2 embeds the query fail-soft: on embed error it logs a warn and SKIPS Phase 2 (returns
  Phase-1 BM25 only) — recall NEVER 500s.
- **REQ-16** Phase-2 vector hits are appended AFTER the BM25 results, deduped by id (never duplicate a row
  already returned by Phase 1). Final first-page order: staged (source:"staged") → BM25 → semantic.
- **REQ-17** `total_matches` reflects the BM25 FTS count; semantic hits are additive extras (documented).
  Vector-fallback rows are authoritative memories → `source:"main"`. The keyset cursor is BM25-only and unchanged.

## Wiring
- **REQ-18** `embedder: Embedder` is added to `AppServices` AND `HandlerDeps`; the recall handler also receives
  `semanticFallbackMinResults` + `semanticFallbackK`; `PromoteService` receives `embedder` as a constructor dep.
  Constructed once at the composition root (stub vs Bedrock, config-guarded); the per-request `Deps` assembly carries them.

## Tests + gate
- **REQ-19** Unit: StubEmbedder determinism/dim/norm; BedrockEmbedder throws + caller fail-soft; config guard
  matrix; two-phase handler — (a) BM25 `≥N` → embedder NOT called; (b) BM25 `<N` → embed + recallSemantic +
  deduped append; (c) embed throws → BM25-only (no 500); (d) cursor page → Phase 2 never runs; promote writes
  embedding + fail-soft NULL + deprecate skips embed.
- **REQ-20** DB-gated integration (skipped without `DATABASE_URL`, uses StubEmbedder): extension/column/index
  exist; `recallSemantic` returns a vector-near seeded row (vectors controlled directly) via HNSW; rows with
  `embedding IS NULL` are excluded from the vector search.
- **REQ-21** `pnpm build && pnpm test -- --run && pnpm lint` all green; existing 371 tests stay passing (Phase-1
  recall behavior unchanged).

## Out of scope (must NOT appear)
- **REQ-22** No real Bedrock invoke / no `@aws-sdk` dep; no query-embedding cache; no backfill; no `CONCURRENTLY`
  index; no paginating semantic hits; no weighted-score fusion / RRF; existing BM25 recall SQL/cursor/COUNT untouched.
