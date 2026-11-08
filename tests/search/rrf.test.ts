/**
 * Pure RRF fusion tests (HU-08.1): score = Σ 1/(k + rank), ranks 1-based,
 * ties broken by memory id, repo priority as a stable partition, offset cursor.
 */

import { describe, it, expect } from 'vitest';
import {
  fuseRrf,
  prioritizeRepo,
  encodeOffsetCursor,
  decodeOffsetCursor,
  RRF_K,
} from '../../src/search/rrf.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';

const row = (id: string, repo_id: string | null = null) => ({ id, repo_id });

describe('fuseRrf', () => {
  it('uses k = 60 by default', () => {
    expect(RRF_K).toBe(60);
  });

  it('spec scenario: A (lex 1st, sem 3rd), B (lex 2nd), C (sem 1st) => A, C, B', () => {
    const A = row('a');
    const B = row('b');
    const C = row('c');
    const F = row('f'); // semantic filler at rank 2: ties B on score, loses on id

    const fused = fuseRrf([A, B], [C, F, A]);

    expect(fused.map((f) => f.row.id)).toEqual(['a', 'c', 'b', 'f']);
    const byId = new Map(fused.map((f) => [f.row.id, f.score]));
    expect(byId.get('a')).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(byId.get('c')).toBeCloseTo(1 / 61, 12);
    expect(byId.get('b')).toBeCloseTo(1 / 62, 12);
  });

  it('uses 1-based ranks (first item scores 1/(k+1))', () => {
    const fused = fuseRrf([row('a')], []);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12);
  });

  it('honours a custom k', () => {
    const fused = fuseRrf([row('a')], [row('a')], { k: 5 });
    expect(fused[0]!.score).toBeCloseTo(2 / 6, 12);
  });

  it('deduplicates a memory present in both lists', () => {
    const fused = fuseRrf([row('a'), row('b')], [row('b'), row('a')]);
    expect(fused.map((f) => f.row.id).sort()).toEqual(['a', 'b']);
  });

  it('breaks equal scores by memory id (ascending), deterministically', () => {
    // b is 1st lexically, a is 1st semantically: identical scores.
    const fused = fuseRrf([row('b')], [row('a')]);
    expect(fused.map((f) => f.row.id)).toEqual(['a', 'b']);
    const fusedAgain = fuseRrf([row('b')], [row('a')]);
    expect(fusedAgain.map((f) => f.row.id)).toEqual(['a', 'b']);
  });

  it('returns the lexical ranking alone when the semantic list is empty', () => {
    const fused = fuseRrf([row('c'), row('a'), row('b')], []);
    expect(fused.map((f) => f.row.id)).toEqual(['c', 'a', 'b']);
  });

  it('returns an empty list when both lists are empty', () => {
    expect(fuseRrf([], [])).toEqual([]);
  });
});

describe('prioritizeRepo', () => {
  it('moves query-repo rows first, keeping relative order inside each group (stable)', () => {
    const fused = fuseRrf(
      [row('a', 'other'), row('b', 'mine'), row('c', 'other'), row('d', 'mine')],
      [],
    );
    const out = prioritizeRepo(fused, 'mine');
    expect(out.map((f) => f.row.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves the order untouched when no row belongs to the query repo', () => {
    const fused = fuseRrf([row('a', 'x'), row('b', 'y')], []);
    expect(prioritizeRepo(fused, 'mine').map((f) => f.row.id)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const fused = fuseRrf([row('a', 'other'), row('b', 'mine')], []);
    prioritizeRepo(fused, 'mine');
    expect(fused.map((f) => f.row.id)).toEqual(['a', 'b']);
  });
});

describe('offset cursor codec', () => {
  it('encodes as base64url("o:<offset>")', () => {
    expect(encodeOffsetCursor(5)).toBe(Buffer.from('o:5', 'utf8').toString('base64url'));
  });

  it('round-trips offsets', () => {
    for (const n of [0, 1, 5, 49, 100]) {
      expect(decodeOffsetCursor(encodeOffsetCursor(n))).toBe(n);
    }
  });

  it.each([
    ['empty string', ''],
    ['not base64 of our format', 'not-a-cursor!!'],
    ['wrong prefix', Buffer.from('x:5', 'utf8').toString('base64url')],
    ['missing offset', Buffer.from('o:', 'utf8').toString('base64url')],
    ['negative offset', Buffer.from('o:-1', 'utf8').toString('base64url')],
    ['fractional offset', Buffer.from('o:1.5', 'utf8').toString('base64url')],
    ['non-numeric offset', Buffer.from('o:abc', 'utf8').toString('base64url')],
    ['trailing garbage', Buffer.from('o:5:extra', 'utf8').toString('base64url')],
    [
      'legacy keyset cursor',
      Buffer.from('0.5:11111111-1111-1111-1111-111111111111', 'utf8').toString('base64url'),
    ],
  ])('rejects %s with INVALID_REFERENCE', (_label, cursor) => {
    let thrown: unknown;
    try {
      decodeOffsetCursor(cursor);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ErrorCode.INVALID_REFERENCE);
  });
});
