import { describe, expect, it } from 'vitest';
import { defaultRevisionPair, diffFields } from './revisionDiff';

describe('defaultRevisionPair', () => {
  it('null with fewer than two revisions', () => {
    expect(defaultRevisionPair([])).toBeNull();
    expect(defaultRevisionPair([{ revisionNo: 1 }])).toBeNull();
  });

  it('previous vs current (list is newest first)', () => {
    expect(defaultRevisionPair([{ revisionNo: 3 }, { revisionNo: 2 }, { revisionNo: 1 }])).toEqual({
      from: 2,
      to: 3,
    });
  });
});

describe('diffFields', () => {
  it('spec scenario: rationale changed, scope added, unchanged keys omitted', () => {
    expect(
      diffFields({ rationale: 'a', owner: 'x' }, { rationale: 'b', scope: 'api', owner: 'x' }),
    ).toEqual([
      { key: 'rationale', kind: 'changed', before: 'a', after: 'b' },
      { key: 'scope', kind: 'added', before: null, after: 'api' },
    ]);
  });

  it('removed keys and sorted output', () => {
    expect(diffFields({ z: 'z', a: 'a' }, {})).toEqual([
      { key: 'a', kind: 'removed', before: 'a', after: null },
      { key: 'z', kind: 'removed', before: 'z', after: null },
    ]);
  });

  it('non-string values are compared and shown as JSON text', () => {
    expect(diffFields({ steps: ['a'], n: 1 }, { steps: ['a', 'b'], n: 1 })).toEqual([
      { key: 'steps', kind: 'changed', before: '["a"]', after: '["a","b"]' },
    ]);
  });

  it('no changes → empty list', () => {
    expect(diffFields({ a: 'x' }, { a: 'x' })).toEqual([]);
  });
});
