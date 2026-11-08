/**
 * C4: repositories that compute revalidate_at refuse an invalid
 * revalidationDays (defence in depth for callers that bypass loadConfig).
 */

import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { PgPromotionRepository } from '../../src/db/promotionRepository.js';
import { PgLifecycleRepository } from '../../src/db/lifecycleRepository.js';

const pool = {} as pg.Pool;

describe('PgPromotionRepository revalidationDays guard', () => {
  it.each([0, -1, 1.5, Number.NaN])('throws on %s', (v) => {
    expect(
      () => new PgPromotionRepository(pool, { quarantineRetentionDays: 60, revalidationDays: v }),
    ).toThrow(/revalidationDays/);
  });

  it('accepts a positive integer', () => {
    expect(
      () => new PgPromotionRepository(pool, { quarantineRetentionDays: 60, revalidationDays: 60 }),
    ).not.toThrow();
  });
});

describe('PgLifecycleRepository revalidationDays guard', () => {
  it.each([0, -1, 1.5, Number.NaN])('throws on %s', (v) => {
    expect(() => new PgLifecycleRepository(pool, { revalidationDays: v })).toThrow(
      /revalidationDays/,
    );
  });
});
