/**
 * Handle codec — server-only, no DB column.
 *
 * Invariant: a handle is valid to serve iff the memory exists, is `active`,
 * is in the caller's project, AND `current_revision === decodedRevision`.
 * Any deviation produces ONE opaque AppError(INVALID_REFERENCE) — the caller
 * never learns which condition failed (contract §6, OWASP enumeration guard).
 *
 * Encoding: base64url("<memory_id>:<revision_no>")
 *   - memory_id is a UUID (contains only hex digits and hyphens — no ':').
 *   - revision_no is a positive integer (no ':').
 *   - Splitting the decoded string on ':' is therefore unambiguous (D3).
 */

import { AppError, ErrorCode } from '../errors/appError.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DecodedHandle {
  memoryId: string;
  revisionNo: number;
}

/**
 * Encodes a (memoryId, revisionNo) pair as an opaque base64url string.
 * This is the only way handles are produced — always from the freshest
 * `current_revision` of an active memory row.
 */
export function encodeHandle(memoryId: string, revisionNo: number): string {
  return Buffer.from(`${memoryId}:${revisionNo}`, 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque handle.
 * Throws AppError(INVALID_REFERENCE) on any malformed input — no detail leaked.
 */
export function decodeHandle(handle: string): DecodedHandle {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }
  // Node never throws on Buffer.from(…, 'base64url'); the post-decode UUID regex
  // and integer validators below are the sole guards against malformed input.
  const raw = Buffer.from(handle, 'base64url').toString('utf8');

  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) throw new AppError(ErrorCode.INVALID_REFERENCE);

  const memoryId = raw.slice(0, colonIdx);
  const revStr = raw.slice(colonIdx + 1);

  // Ensure no additional ':' in revStr (UUID has no ':', so a second ':' means tampering).
  if (revStr.includes(':')) throw new AppError(ErrorCode.INVALID_REFERENCE);
  if (!UUID_REGEX.test(memoryId)) throw new AppError(ErrorCode.INVALID_REFERENCE);

  const revisionNo = Number(revStr);
  if (!Number.isInteger(revisionNo) || revisionNo < 1) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }

  return { memoryId, revisionNo };
}

/**
 * Returns true when the memory has advanced past the handle's revision (D3).
 * The handler treats both stale (`current > decoded`) and the impossible
 * `current < decoded` case as the same opaque reference error — never
 * revealing which branch was taken (contract §6).
 */
export function isHandleStale(currentRevision: number, decodedRevision: number): boolean {
  return currentRevision > decodedRevision;
}
