/**
 * T019: Promote-pipeline config guard — load-bearing fail-fast tests.
 *
 * Covers the superRefine guards added for JUDGE_STUB and PROMOTE_OIDC_DEV_BYPASS
 * without duplicating the AUTH_DEV_BYPASS cases already in prodGuard.test.ts:
 *
 *  (a) JUDGE_STUB=true + NODE_ENV=production          → loadConfig() calls process.exit(1)
 *  (b) PROMOTE_OIDC_DEV_BYPASS=true + NODE_ENV=production → process.exit(1)
 *  (c) JUDGE_STUB=false (dev) without BEDROCK_MODEL_ID → process.exit(1)
 *  (d) PROMOTE_OIDC_DEV_BYPASS=false without GITHUB_OIDC_AUDIENCE → process.exit(1)
 *  (e) valid dev combo (JUDGE_STUB=true + PROMOTE_OIDC_DEV_BYPASS=true) loads OK;
 *      .transform yields booleans — 'true' → true; 'false' → false.
 *
 * Same spy pattern as prodGuard.test.ts: spy process.exit to throw a sentinel
 * error instead of terminating the test process; replace process.env wholesale
 * per test and restore in afterEach.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Capture the original env once, before any test mutation.
const ORIG = { ...process.env };

afterEach(() => {
  // Restore to the original state so later tests are not polluted.
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

/**
 * Clears the module registry and re-imports config/index.ts so each test
 * exercises loadConfig() against the current process.env, not a stale closure.
 */
async function loadFresh(): Promise<() => ReturnType<typeof import('../../src/config/index.js').loadConfig>> {
  vi.resetModules();
  const mod = await import('../../src/config/index.js');
  return mod.loadConfig;
}

describe('config promote guard (JUDGE_STUB + PROMOTE_OIDC_DEV_BYPASS + superRefine)', () => {
  // ── (a) Forbidden pairing: JUDGE_STUB=true + prod ───────────────────────
  it('fails fast (process.exit(1)) when JUDGE_STUB=true and NODE_ENV=production', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      JUDGE_STUB: 'true',
      NODE_ENV: 'production',
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── (b) Forbidden pairing: PROMOTE_OIDC_DEV_BYPASS=true + prod ──────────
  it('fails fast (process.exit(1)) when PROMOTE_OIDC_DEV_BYPASS=true and NODE_ENV=production', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      NODE_ENV: 'production',
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── (c) Real judge path: BEDROCK_MODEL_ID required ───────────────────────
  it('fails fast (process.exit(1)) when JUDGE_STUB is not true and BEDROCK_MODEL_ID is absent', async () => {
    // AUTH_DEV_BYPASS and PROMOTE_OIDC_DEV_BYPASS are true to isolate this guard.
    // JUDGE_STUB is intentionally absent (defaults to false). BEDROCK_MODEL_ID absent.
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      NODE_ENV: 'development',
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── (d) Real OIDC verifier path: GITHUB_OIDC_AUDIENCE required ───────────
  it('fails fast (process.exit(1)) when PROMOTE_OIDC_DEV_BYPASS is not true and GITHUB_OIDC_AUDIENCE is absent', async () => {
    // AUTH_DEV_BYPASS and JUDGE_STUB are true to isolate this guard.
    // PROMOTE_OIDC_DEV_BYPASS is intentionally absent (defaults to false). GITHUB_OIDC_AUDIENCE absent.
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      NODE_ENV: 'development',
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  // ── (e) Valid dev combo loads OK; transform yields booleans ──────────────
  it('loads successfully with JUDGE_STUB=true + PROMOTE_OIDC_DEV_BYPASS=true and transforms strings to booleans', async () => {
    // 'true' string → boolean true
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      NODE_ENV: 'development',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.JUDGE_STUB).toBe(true);
    expect(cfg.PROMOTE_OIDC_DEV_BYPASS).toBe(true);

    // 'false' string → boolean false (real vars supplied to satisfy the required guards)
    // AWS_REGION is required when JUDGE_STUB=false (real Bedrock judge path).
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      NODE_ENV: 'development',
      JUDGE_STUB: 'false',
      BEDROCK_MODEL_ID: 'anthropic.claude-3-5-sonnet-20241022',
      AWS_REGION: 'us-east-1',
      PROMOTE_OIDC_DEV_BYPASS: 'false',
      GITHUB_OIDC_AUDIENCE: 'https://github.com/crombie-dev',
      EMBEDDER_STUB: 'true',
    };

    const loadConfig2 = await loadFresh();
    const cfg2 = loadConfig2();

    expect(cfg2.JUDGE_STUB).toBe(false);
    expect(cfg2.PROMOTE_OIDC_DEV_BYPASS).toBe(false);
  });
});
