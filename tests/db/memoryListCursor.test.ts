/** Memory list keyset cursor codec (C5): round trip and malformed input → INVALID_REQUEST. */

import { describe, it, expect } from 'vitest';
import {
  decodeMemoryListCursor,
  encodeMemoryListCursor,
} from '../../src/db/memoryAdminRepository.js';
import { ErrorCode } from '../../src/errors/appError.js';

const ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const KEY = '2026-11-07T21:09:14.656123Z';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('memory list cursor', () => {
  it('round-trips with microseconds', () => {
    const c = encodeMemoryListCursor({ updatedKey: KEY, id: ID });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMemoryListCursor(c)).toEqual({ updatedKey: KEY, id: ID });
  });

  it('accepts a leap day and the last microsecond of a day', () => {
    for (const key of ['2028-02-29T23:59:59.999999Z', '2026-12-31T00:00:00.000000Z']) {
      expect(decodeMemoryListCursor(b64(`${key}|${ID}`))).toEqual({ updatedKey: key, id: ID });
    }
  });

  it.each([
    ['not base64 at all', '%%%'],
    ['missing separator', b64(`${KEY}${ID}`)],
    ['milliseconds only', b64(`2026-11-07T21:09:14.656Z|${ID}`)],
    ['non-UUID id', b64(`${KEY}|not-a-uuid`)],
    ['empty parts', b64('|')],
    ['trailing garbage after the timestamp', b64(`${KEY}' OR 1=1|${ID}`)],
    // SEC-L1: the shape matches but the date does not exist (Postgres 22008 → would be a 500).
    ['month 13 / hour 25', b64(`2026-13-45T25:61:61.000000Z|${ID}`)],
    ['February 30', b64(`2026-02-30T00:00:00.000000Z|${ID}`)],
    ['hour 24', b64(`2026-11-07T24:00:00.000000Z|${ID}`)],
    ['year 0000', b64(`0000-01-01T00:00:00.000000Z|${ID}`)],
  ])('%s → INVALID_REQUEST', (_label, raw) => {
    expect(() => decodeMemoryListCursor(raw)).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_REQUEST }),
    );
  });
});
