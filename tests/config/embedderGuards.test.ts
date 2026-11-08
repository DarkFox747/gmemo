/**
 * T014 / T009 migration: Embedder config guards — load-bearing fail-fast tests.
 *
 * Covers the superRefine guards added for EMBEDDER_STUB,
 * AWS_REGION (real Bedrock path), and BEDROCK_MAX_ATTEMPTS / BEDROCK_TIMEOUT_MS
 * WITHOUT duplicating the AUTH_DEV_BYPASS, JUDGE_STUB, or PROMOTE_OIDC_DEV_BYPASS
 * cases in the sibling test files:
 *
 *  (a) EMBEDDER_STUB=true + NODE_ENV=production          → loadConfig() calls process.exit(1)
 *  (b) EMBEDDER_STUB=false (dev) without BEDROCK_EMBEDDING_MODEL_ID → process.exit(1)
 *  (c) valid dev combo (EMBEDDER_STUB=true, JUDGE_STUB=true) loads OK;
 *      the removed SEMANTIC_FALLBACK_* settings are no longer part of the config
 *      (RRF constants are named constants, not config).
 *  (d) AWS_REGION required when EMBEDDER_STUB=false (real Bedrock embedder active).
 *  (e) AWS_REGION required when JUDGE_STUB=false (real Bedrock judge active).
 *  (f) AWS_REGION not required when BOTH stubs are true (no real Bedrock client).
 *  (g) BEDROCK_MAX_ATTEMPTS defaults to 3; numeric-string override parsed to number.
 *  (h) BEDROCK_TIMEOUT_MS defaults to 15000; numeric-string override parsed to number.
 *
 * Same spy pattern as promoteConfig.test.ts: spy process.exit to throw a sentinel
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

describe('config embedder guards (EMBEDDER_STUB + superRefine)', () => {
  // ── (a) Forbidden pairing: EMBEDDER_STUB=true + prod ────────────────────
  it('fails fast (process.exit(1)) when EMBEDDER_STUB=true and NODE_ENV=production', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      EMBEDDER_STUB: 'true',
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

  // ── (b) Real embedder path: BEDROCK_EMBEDDING_MODEL_ID required ──────────
  it('fails fast (process.exit(1)) when EMBEDDER_STUB is not true and BEDROCK_EMBEDDING_MODEL_ID is absent', async () => {
    // AUTH_DEV_BYPASS, JUDGE_STUB, and PROMOTE_OIDC_DEV_BYPASS are true to isolate
    // this guard. EMBEDDER_STUB is intentionally absent (defaults to false).
    // BEDROCK_EMBEDDING_MODEL_ID is absent.
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
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

  // ── (c) Valid dev combo loads OK; the old semantic-fallback settings are gone
  it('loads successfully with EMBEDDER_STUB=true and exposes no SEMANTIC_FALLBACK_* settings', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      NODE_ENV: 'development',
      // Legacy env vars must be ignored, not parsed into the config.
      SEMANTIC_FALLBACK_MIN_RESULTS: '3',
      SEMANTIC_FALLBACK_K: '12',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.EMBEDDER_STUB).toBe(true);
    expect(cfg).not.toHaveProperty('SEMANTIC_FALLBACK_MIN_RESULTS');
    expect(cfg).not.toHaveProperty('SEMANTIC_FALLBACK_K');
  });
});

describe('config AWS_REGION guard (required when real Bedrock client is active)', () => {
  // ── (d) Real embedder active → AWS_REGION required ──────────────────────
  it('fails fast (process.exit(1)) when EMBEDDER_STUB=false and AWS_REGION is absent', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'false',
      BEDROCK_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
      // AWS_REGION intentionally absent
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

  // ── (e) Real judge active → AWS_REGION required ──────────────────────────
  it('fails fast (process.exit(1)) when JUDGE_STUB=false and AWS_REGION is absent', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'false',
      BEDROCK_MODEL_ID: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      // AWS_REGION intentionally absent
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

  // ── (f) Both stubs → AWS_REGION not required ─────────────────────────────
  it('loads successfully without AWS_REGION when both EMBEDDER_STUB and JUDGE_STUB are true', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      // AWS_REGION intentionally absent — should not be required when both stubs are on
      NODE_ENV: 'development',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.AWS_REGION).toBeUndefined();
    expect(cfg.EMBEDDER_STUB).toBe(true);
    expect(cfg.JUDGE_STUB).toBe(true);
  });
});

describe('config BEDROCK_MAX_ATTEMPTS and BEDROCK_TIMEOUT_MS defaults and overrides', () => {
  // ── (g) BEDROCK_MAX_ATTEMPTS defaults to 3 ──────────────────────────────
  it('BEDROCK_MAX_ATTEMPTS defaults to 3 when not set', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      NODE_ENV: 'development',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.BEDROCK_MAX_ATTEMPTS).toBe(3);
    expect(typeof cfg.BEDROCK_MAX_ATTEMPTS).toBe('number');
  });

  it('BEDROCK_MAX_ATTEMPTS parses a numeric-string override', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      NODE_ENV: 'development',
      BEDROCK_MAX_ATTEMPTS: '5',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.BEDROCK_MAX_ATTEMPTS).toBe(5);
    expect(typeof cfg.BEDROCK_MAX_ATTEMPTS).toBe('number');
  });

  // ── (h) BEDROCK_TIMEOUT_MS defaults to 15000 ────────────────────────────
  it('BEDROCK_TIMEOUT_MS defaults to 15000 when not set', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      NODE_ENV: 'development',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.BEDROCK_TIMEOUT_MS).toBe(15000);
    expect(typeof cfg.BEDROCK_TIMEOUT_MS).toBe('number');
  });

  it('BEDROCK_TIMEOUT_MS parses a numeric-string override', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      NODE_ENV: 'development',
      BEDROCK_TIMEOUT_MS: '30000',
    };

    const loadConfig = await loadFresh();
    const cfg = loadConfig();

    expect(cfg.BEDROCK_TIMEOUT_MS).toBe(30000);
    expect(typeof cfg.BEDROCK_TIMEOUT_MS).toBe('number');
  });
});
