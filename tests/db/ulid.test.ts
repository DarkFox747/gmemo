/**
 * T026: ulid() unit tests.
 *
 * Covers:
 *  1. Format: exactly 26 characters.
 *  2. Alphabet: only Crockford base32 characters (0–9, A–Z excluding I, L, O, U).
 *  3. Uniqueness: no collisions across a large batch.
 *  4. Timestamp-prefix ordering: the first 10 characters of a ULID generated at
 *     a later timestamp sort >= those of a ULID generated at an earlier timestamp
 *     (Crockford base32 is lexicographically ordered by numeric value).
 *
 * Design ref: src/db/ulid.ts; SDD convention "ULID for time-sortable staging_session".
 * Note: strict monotonicity within the same millisecond is NOT guaranteed by
 * design — only the timestamp portion (chars 0–9) is tested for ordering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ulid } from '../../src/db/ulid.js';

/** The Crockford base32 alphabet used by this implementation. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters that must NEVER appear in a Crockford base32 string. */
const EXCLUDED_CHARS = ['I', 'L', 'O', 'U'];

// ---------------------------------------------------------------------------
// 1. Format — 26 characters
// ---------------------------------------------------------------------------

describe('ulid — format', () => {
  it('returns exactly 26 characters', () => {
    expect(ulid()).toHaveLength(26);
  });

  it('returns a string (not null, not undefined)', () => {
    const id = ulid();
    expect(typeof id).toBe('string');
    expect(id.length).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// 2. Alphabet — Crockford base32 only
// ---------------------------------------------------------------------------

describe('ulid — Crockford base32 alphabet', () => {
  it('every character belongs to the Crockford base32 alphabet', () => {
    const id = ulid();
    for (const char of id) {
      expect(CROCKFORD_ALPHABET).toContain(char);
    }
  });

  it('never contains excluded characters (I, L, O, U)', () => {
    // Generate a batch to reduce the chance of a false pass on a single ULID.
    const ids = Array.from({ length: 200 }, () => ulid());
    for (const id of ids) {
      for (const excluded of EXCLUDED_CHARS) {
        expect(id).not.toContain(excluded);
      }
    }
  });

  it('alphabet invariant holds across a batch of 1 000 ULIDs', () => {
    const ids = Array.from({ length: 1_000 }, () => ulid());
    for (const id of ids) {
      expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Uniqueness — no collisions across a large batch
// ---------------------------------------------------------------------------

describe('ulid — uniqueness', () => {
  it('generates unique values across 10 000 calls', () => {
    const COUNT = 10_000;
    const ids = new Set(Array.from({ length: COUNT }, () => ulid()));
    expect(ids.size).toBe(COUNT);
  });
});

// ---------------------------------------------------------------------------
// 4. Timestamp-prefix ordering
// ---------------------------------------------------------------------------

describe('ulid — timestamp-prefix ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a ULID generated at a later millisecond has a >= timestamp prefix', () => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const earlier = ulid();

    // Advance by 1 second (well past any same-millisecond ambiguity).
    vi.setSystemTime(new Date('2025-01-01T00:00:01.000Z'));
    const later = ulid();

    // The timestamp portion is the first 10 characters.
    const earlierPrefix = earlier.slice(0, 10);
    const laterPrefix = later.slice(0, 10);

    // Crockford base32 is lexicographically ordered, so string >= is equivalent
    // to numeric (timestamp) >=.
    expect(laterPrefix >= earlierPrefix).toBe(true);
  });

  it('full ULID from a later timestamp sorts lexicographically after earlier', () => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const earlier = ulid();

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // one year later
    const later = ulid();

    expect(later > earlier).toBe(true);
  });

  it('ULIDs at the same millisecond have identical timestamp prefixes', () => {
    vi.setSystemTime(new Date('2025-07-15T12:00:00.000Z'));
    const a = ulid();
    const b = ulid(); // same frozen millisecond

    // Both must share the same 10-char timestamp segment.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it('timestamp prefix is strictly greater when time advances by 1 ms', () => {
    vi.setSystemTime(new Date('2025-07-15T12:00:00.000Z'));
    const earlier = ulid();

    vi.setSystemTime(new Date('2025-07-15T12:00:00.001Z')); // +1 ms
    const later = ulid();

    const earlierPrefix = earlier.slice(0, 10);
    const laterPrefix = later.slice(0, 10);

    // A 1 ms advance must produce a strictly greater prefix because the 48-bit
    // timestamp value is larger and encoded big-endian.
    expect(laterPrefix > earlierPrefix).toBe(true);
  });
});
