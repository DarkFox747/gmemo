/**
 * Config — QUARANTINE_RETENTION_DAYS and JOBS_TOKEN (C3).
 * Same spy pattern as promoteConfig.test.ts: process.exit throws a sentinel.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

async function loadFresh() {
  vi.resetModules();
  const mod = await import('../../src/config/index.js');
  return mod.loadConfig;
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

async function expectExit(env: Record<string, string>): Promise<void> {
  process.env = env;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const loadConfig = await loadFresh();
  expect(() => loadConfig()).toThrow('exit');
  expect(exit).toHaveBeenCalledWith(1);
}

describe('config QUARANTINE_RETENTION_DAYS', () => {
  it('defaults to 60', async () => {
    process.env = devEnv();
    const cfg = (await loadFresh())();
    expect(cfg.QUARANTINE_RETENTION_DAYS).toBe(60);
  });

  it('accepts a valid integer', async () => {
    process.env = devEnv({ QUARANTINE_RETENTION_DAYS: '30' });
    expect((await loadFresh())().QUARANTINE_RETENTION_DAYS).toBe(30);
  });

  it.each(['0', '', '-1', '1.5', 'abc', '3651'])('rejects %j', async (v) => {
    await expectExit(devEnv({ QUARANTINE_RETENTION_DAYS: v }));
  });
});

describe('config JOBS_TOKEN', () => {
  it('is optional', async () => {
    process.env = devEnv();
    expect((await loadFresh())().JOBS_TOKEN).toBeUndefined();
  });

  it('rejects a 31-char token', async () => {
    await expectExit(devEnv({ JOBS_TOKEN: 'a'.repeat(31) }));
  });

  it('accepts a 32-char token', async () => {
    process.env = devEnv({ JOBS_TOKEN: 'a'.repeat(32) });
    expect((await loadFresh())().JOBS_TOKEN).toBe('a'.repeat(32));
  });

  it('trims before the length check', async () => {
    await expectExit(devEnv({ JOBS_TOKEN: ` ${'a'.repeat(31)} ` }));
  });
});
