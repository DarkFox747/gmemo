import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Returns the SHA-256 hex digest of the given UTF-8 string.
 *
 * Used server-side to produce `query_hash` values stored in `access_log`.
 * The raw query text is never persisted — only its digest — so individual
 * queries cannot be reconstructed from the audit trail.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Compares two strings in constant time to prevent timing-based side-channel
 * attacks. Length is checked first; if lengths differ, returns false without
 * calling timingSafeEqual (note: the length values themselves are not secret
 * in this use-case — the comparison result is).
 *
 * This is the required API for future token_hash comparisons on the
 * machine-credential path — use this function, never `===`, for secret values.
 *
 * Note: constant-time comparison is intentionally deferred until the
 * machine-credential path is implemented; this function is ready for that use.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
