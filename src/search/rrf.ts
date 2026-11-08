/**
 * Reciprocal Rank Fusion for hybrid recall (HU-08.1). Pure functions, no I/O.
 *
 *   score(d) = Σ_i 1 / (k + rank_i(d))      ranks are 1-based, k = RRF_K
 *
 * Offset cursor: a fused, query-time score has no stable keyset, so pagination
 * walks the fused list by offset. The cursor is opaque base64url("o:<offset>").
 */

import { AppError, ErrorCode } from '../errors/appError.js';

/** RRF smoothing constant (named constant, not config — YAGNI). */
export const RRF_K = 60;
/** Candidates requested from each ranking before fusion. */
export const RRF_CANDIDATES = 50;

export interface FusedCandidate<T> {
  row: T;
  score: number;
}

/**
 * Fuses two ranked lists. A row present in both lists accumulates both terms.
 * Equal scores are ordered by memory id (ascending) so the result is deterministic.
 */
export function fuseRrf<T extends { id: string }>(
  lexical: readonly T[],
  semantic: readonly T[],
  opts: { k?: number } = {},
): FusedCandidate<T>[] {
  const k = opts.k ?? RRF_K;
  const byId = new Map<string, FusedCandidate<T>>();

  for (const list of [lexical, semantic]) {
    list.forEach((row, index) => {
      const term = 1 / (k + index + 1); // index + 1 = 1-based rank
      const existing = byId.get(row.id);
      if (existing) {
        existing.score += term;
      } else {
        byId.set(row.id, { row, score: term });
      }
    });
  }

  return [...byId.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.row.id < b.row.id) return -1;
    return a.row.id > b.row.id ? 1 : 0;
  });
}

/**
 * Stable partition: rows of the query's repo first, then the rest of the
 * project; relative (fused) order is preserved inside each group.
 */
export function prioritizeRepo<T extends { repo_id?: string | null }>(
  fused: readonly FusedCandidate<T>[],
  repoId: string,
): FusedCandidate<T>[] {
  const inRepo = fused.filter((f) => f.row.repo_id === repoId);
  const rest = fused.filter((f) => f.row.repo_id !== repoId);
  return [...inRepo, ...rest];
}

/** Encodes a fused-list offset as base64url("o:<offset>"). */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

/**
 * Decodes an offset cursor. Throws AppError(INVALID_REFERENCE) on any malformed
 * input — the same opaque error class as an invalid handle.
 */
export function decodeOffsetCursor(cursor: string): number {
  // Node never throws on Buffer.from(…, 'base64url'); the strict pattern and the
  // round-trip check below are the guards against malformed input.
  const match = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) throw new AppError(ErrorCode.INVALID_REFERENCE);
  const offset = Number(match[1]);
  if (encodeOffsetCursor(offset) !== cursor) throw new AppError(ErrorCode.INVALID_REFERENCE);
  return offset;
}
