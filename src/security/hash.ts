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

export interface ContentHashInput {
  op: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  fields?: Record<string, unknown>;
  /** Target memory id for non-add ops, `null` for add. */
  target: string | null;
}

/**
 * Returns the SHA-256 hex digest of the fixed-key-order canonical JSON of a
 * staged item. Extracted verbatim from the capture path (remember step 5):
 * the key order and the `fields ?? {}` default MUST NOT change, otherwise the
 * hashes of already-staged rows (and their UNIQUE dedup) would stop matching.
 */
export function computeContentHash(input: ContentHashInput): string {
  const canonical = JSON.stringify({
    op: input.op,
    type: input.type,
    title: input.title,
    summary: input.summary,
    body: input.body,
    fields: input.fields ?? {},
    target: input.target,
  });
  return sha256Hex(canonical);
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
