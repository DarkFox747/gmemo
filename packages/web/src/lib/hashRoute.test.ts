import { describe, expect, it } from 'vitest';
import { buildHash, parseHash } from './hashRoute';

const ID = '00000000-0000-0000-0000-000000000301';

describe('parseHash', () => {
  it.each([
    ['#/review', { name: 'review' }],
    [`#/review/${ID}`, { name: 'reviewDetail', itemId: ID }],
    ['#/memory', { name: 'memory' }],
    ['#/memory/new', { name: 'memoryNew' }],
    [`#/memory/${ID}`, { name: 'memoryDetail', memoryId: ID }],
    [`#/memory/${ID}/edit`, { name: 'memoryEdit', memoryId: ID }],
    ['#/quarantine', { name: 'quarantine' }],
    [`#/quarantine/${ID}`, { name: 'quarantineDetail', id: ID }],
    ['#/admin', { name: 'admin' }],
  ])('%s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it('round trip buildHash(parseHash(h)) === h', () => {
    for (const h of [
      '#/review',
      `#/review/${ID}`,
      '#/memory',
      '#/memory/new',
      `#/memory/${ID}`,
      `#/memory/${ID}/edit`,
      '#/quarantine',
      `#/quarantine/${ID}`,
      '#/admin',
    ]) {
      expect(buildHash(parseHash(h))).toBe(h);
    }
  });

  it('empty or unknown → review', () => {
    expect(parseHash('')).toEqual({ name: 'review' });
    expect(parseHash('#')).toEqual({ name: 'review' });
    expect(parseHash('#/nope')).toEqual({ name: 'review' });
  });

  it('a non-UUID id falls back to the list route', () => {
    expect(parseHash('#/review/not-a-uuid')).toEqual({ name: 'review' });
    expect(parseHash('#/memory/<script>/edit')).toEqual({ name: 'memory' });
    expect(parseHash('#/quarantine/1')).toEqual({ name: 'quarantine' });
  });

  it('tolerates a trailing slash', () => {
    expect(parseHash('#/admin/')).toEqual({ name: 'admin' });
    expect(parseHash(`#/review/${ID}/`)).toEqual({ name: 'reviewDetail', itemId: ID });
  });
});
