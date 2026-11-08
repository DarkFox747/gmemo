/**
 * Config — REVALIDATION_DAYS (C4, HU-12.1).
 * Same spy pattern as quarantineConfig.test.ts: process.exit throws a sentinel.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

async function loadFresh() {
  vi.resetModules();
  return import('../../src/config/index.js');
}

function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://x/y',
    AUTH_DEV_BYPASS: 'true',
    JUDGE_STUB: 'true',
    PROMOTE_OIDC_DEV_BYPASS: 'true',
    EMBEDDER_STUB: 'true',
    ...extra,
  };
}

describe('config REVALIDATION_DAYS', () => {
  it('defaults to 60', async () => {
    process.env = devEnv();
    expect((await loadFresh()).loadConfig().REVALIDATION_DAYS).toBe(60);
  });

  it('accepts a valid integer', async () => {
    process.env = devEnv({ REVALIDATION_DAYS: '30' });
    expect((await loadFresh()).loadConfig().REVALIDATION_DAYS).toBe(30);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '3651'])('rejects %j', async (v) => {
    process.env = devEnv({ REVALIDATION_DAYS: v });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadConfig } = await loadFresh();
    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exports the same field as revalidationDaysSchema (used by the job script)', async () => {
    const { revalidationDaysSchema } = await loadFresh();
    expect(revalidationDaysSchema.parse(undefined)).toBe(60);
    expect(revalidationDaysSchema.parse('15')).toBe(15);
    expect(revalidationDaysSchema.safeParse('0').success).toBe(false);
  });
});
