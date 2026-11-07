/**
 * toOrQuery — DB-free unit tests (the integration suite also covers the
 * ASCII behaviour against Postgres). SEC L-4: Unicode letters/digits.
 */

import { describe, it, expect } from 'vitest';
import { toOrQuery } from '../../src/db/promotionRepository.js';

describe('toOrQuery', () => {
  it('keeps the ASCII behaviour: lowercase, >= 3 chars, deduped', () => {
    expect(toOrQuery('The Cache TTL', 'cache is on')).toEqual(['the or cache or ttl']);
    expect(toOrQuery('a b', 'to it')).toEqual([]);
  });

  it('keeps accented words whole (no split on non-ASCII letters)', () => {
    expect(toOrQuery('Configuración de sesión', 'Índice único')).toEqual([
      'configuración or sesión or índice or único',
    ]);
  });

  it('drops punctuation and websearch operators — only letter/digit runs survive', () => {
    expect(toOrQuery('"quoted" -negated (paren)', 'año:2024 OR x')).toEqual([
      'quoted or negated or paren or año or 2024',
    ]);
  });
});
