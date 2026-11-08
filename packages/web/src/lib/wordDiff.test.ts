import { describe, expect, it } from 'vitest';
import { MAX_DIFF_TOKENS, addedSide, removedSide, wordDiff } from './wordDiff';

describe('wordDiff', () => {
  it('marks a changed value as removed on one side and added on the other', () => {
    const segs = wordDiff('retry for 30 minutes', 'retry for 5 minutes');
    expect(segs).toEqual([
      { text: 'retry for', kind: 'same' },
      { text: '30', kind: 'removed' },
      { text: '5', kind: 'added' },
      { text: 'minutes', kind: 'same' },
    ]);
    expect(removedSide(segs).map((s) => s.text)).toEqual(['retry for', '30', 'minutes']);
    expect(addedSide(segs).map((s) => s.text)).toEqual(['retry for', '5', 'minutes']);
  });

  it('identical text is one same segment; empty sides work', () => {
    expect(wordDiff('a  b', 'a b')).toEqual([{ text: 'a b', kind: 'same' }]);
    expect(wordDiff('', 'x y')).toEqual([{ text: 'x y', kind: 'added' }]);
    expect(wordDiff('x y', '')).toEqual([{ text: 'x y', kind: 'removed' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('bounded input skips the table and marks everything as changed', () => {
    const big = Array.from({ length: MAX_DIFF_TOKENS + 1 }, (_, i) => `w${i}`).join(' ');
    const segs = wordDiff(big, 'w0');
    expect(segs.map((s) => s.kind)).toEqual(['removed', 'added']);
  });
});
