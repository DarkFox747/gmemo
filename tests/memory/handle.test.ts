/**
 * T244: Handle codec unit tests — encodeHandle / decodeHandle / isHandleStale.
 *
 * All three functions live in src/mcp/handle.ts (Wave 1).
 * These tests exercise the codec in isolation, with no DB or handler involved.
 *
 * Invariant (design D3): a handle is valid to serve iff the memory exists, is
 * active, in the caller's project, AND current_revision === decodedRevision.
 * Any other condition → ONE opaque AppError(INVALID_REFERENCE).
 */

import { describe, it, expect } from 'vitest';
import {
  encodeHandle,
  decodeHandle,
  isHandleStale,
} from '../../src/mcp/handle.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SAMPLE_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// encodeHandle / decodeHandle round-trip
// ---------------------------------------------------------------------------

describe('encodeHandle / decodeHandle round-trip', () => {
  it('encodes and decodes a valid (uuid, revisionNo=1) pair', () => {
    const handle = encodeHandle(SAMPLE_UUID, 1);

    expect(typeof handle).toBe('string');
    expect(handle.length).toBeGreaterThan(0);

    const decoded = decodeHandle(handle);
    expect(decoded.memoryId).toBe(SAMPLE_UUID);
    expect(decoded.revisionNo).toBe(1);
  });

  it('encodes and decodes a larger revisionNo', () => {
    const handle = encodeHandle(OTHER_UUID, 42);
    const decoded = decodeHandle(handle);
    expect(decoded.memoryId).toBe(OTHER_UUID);
    expect(decoded.revisionNo).toBe(42);
  });

  it('produces different handles for different revisionNos on the same id', () => {
    const h1 = encodeHandle(SAMPLE_UUID, 1);
    const h2 = encodeHandle(SAMPLE_UUID, 2);
    expect(h1).not.toBe(h2);
  });

  it('produces different handles for different ids with the same revisionNo', () => {
    const h1 = encodeHandle(SAMPLE_UUID, 1);
    const h2 = encodeHandle(OTHER_UUID, 1);
    expect(h1).not.toBe(h2);
  });

  it('handle is a non-empty string (opaque to the caller)', () => {
    const handle = encodeHandle(SAMPLE_UUID, 5);
    expect(handle.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// decodeHandle — malformed inputs → opaque AppError(INVALID_REFERENCE)
// ---------------------------------------------------------------------------

describe('decodeHandle — malformed inputs', () => {
  /** Asserts that decodeHandle throws AppError(INVALID_REFERENCE). */
  function expectInvalidRef(input: string): void {
    expect(() => decodeHandle(input)).toThrow(AppError);
    try {
      decodeHandle(input);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ErrorCode.INVALID_REFERENCE);
    }
  }

  it('throws INVALID_REFERENCE for an empty string', () => {
    expectInvalidRef('');
  });

  it('throws INVALID_REFERENCE for a raw (non-base64url) string', () => {
    expectInvalidRef('not-a-valid-handle');
  });

  it('throws INVALID_REFERENCE when the decoded content has no colon separator', () => {
    // base64url-encode a string with no ':'
    const noColon = Buffer.from('justtext', 'utf8').toString('base64url');
    expectInvalidRef(noColon);
  });

  it('throws INVALID_REFERENCE when the UUID part is malformed', () => {
    // base64url-encode "not-a-uuid:1"
    const bad = Buffer.from('not-a-uuid:1', 'utf8').toString('base64url');
    expectInvalidRef(bad);
  });

  it('throws INVALID_REFERENCE when revisionNo is zero', () => {
    const bad = Buffer.from(`${SAMPLE_UUID}:0`, 'utf8').toString('base64url');
    expectInvalidRef(bad);
  });

  it('throws INVALID_REFERENCE when revisionNo is negative', () => {
    const bad = Buffer.from(`${SAMPLE_UUID}:-1`, 'utf8').toString('base64url');
    expectInvalidRef(bad);
  });

  it('throws INVALID_REFERENCE when revisionNo is not an integer', () => {
    const bad = Buffer.from(`${SAMPLE_UUID}:1.5`, 'utf8').toString('base64url');
    expectInvalidRef(bad);
  });

  it('throws INVALID_REFERENCE for an extra colon (potential tampering)', () => {
    // e.g. "uuid:1:extra"
    const bad = Buffer.from(`${SAMPLE_UUID}:1:extra`, 'utf8').toString('base64url');
    expectInvalidRef(bad);
  });
});

// ---------------------------------------------------------------------------
// isHandleStale
// ---------------------------------------------------------------------------

describe('isHandleStale', () => {
  it('returns false when currentRevision equals decodedRevision (handle is fresh)', () => {
    expect(isHandleStale(1, 1)).toBe(false);
    expect(isHandleStale(5, 5)).toBe(false);
  });

  it('returns true when currentRevision > decodedRevision (memory has advanced)', () => {
    expect(isHandleStale(2, 1)).toBe(true);
    expect(isHandleStale(10, 3)).toBe(true);
  });

  it('returns false when decodedRevision > currentRevision (impossible state; not stale per D3)', () => {
    // The handler treats this as an opaque error, but isHandleStale itself
    // only flags the "> current" direction.
    expect(isHandleStale(1, 2)).toBe(false);
  });
});
