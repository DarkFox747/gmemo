/**
 * Format a JS vector as a pgvector literal, or NULL.
 * Used by recallSemantic ($qvec) and promotion INSERT/AMEND ($12::vector).
 */
export function toVectorParam(vec: number[] | null): string | null {
  if (vec === null) return null;
  if (!vec.every(Number.isFinite)) return null;
  return `[${vec.join(',')}]`;
}
