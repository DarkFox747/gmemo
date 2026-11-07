/**
 * T341: Config prod guard — load-bearing fail-fast tests.
 *
 * Asserts the three critical behaviors introduced by the AUTH_DEV_BYPASS
 * superRefine in src/config/index.ts:
 *
 *  (a) AUTH_DEV_BYPASS=true + NODE_ENV=production  → loadConfig() calls process.exit(1)
 *  (b) AUTH_DEV_BYPASS=true + NODE_ENV=development → loads OK even without COGNITO_* vars
 *  (c) AUTH_DEV_BYPASS absent/false + any env       → COGNITO_* trio is required; missing → exit(1)
 *
 * loadConfig() calls process.exit(1) on failure, so we spy on process.exit and
 * make it throw a sentinel error instead of terminating the test process.
 *
 * process.env is replaced wholesale per test and restored in afterEach to keep
 * tests isolated (pattern: save ORIG before the suite, restore in afterEach).
 *
 * NOTE: src/config/index.ts is modified by Group A in parallel to add
 * AUTH_DEV_BYPASS and the superRefine prod guard. Until Group A lands, tests (a)
 * and (b) will behave differently from this spec (the current schema has no
 * AUTH_DEV_BYPASS and unconditionally requires COGNITO_*). Report as pending.
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

describe('config prod guard (AUTH_DEV_BYPASS + superRefine)', () => {
  // ── (a) Forbidden pairing: bypass=true + prod ────────────────────────────
  it('fails fast (process.exit(1)) when AUTH_DEV_BYPASS=true and NODE_ENV=production', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
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

  // ── (b) Dev bypass active — COGNITO_* should be optional ────────────────
  it('loads successfully with no COGNITO_* vars when AUTH_DEV_BYPASS=true + NODE_ENV=development', async () => {
    // JUDGE_STUB, PROMOTE_OIDC_DEV_BYPASS, and EMBEDDER_STUB must also be 'true' on
    // the dev path — their superRefine guards require BEDROCK_MODEL_ID /
    // GITHUB_OIDC_AUDIENCE / BEDROCK_EMBEDDING_MODEL_ID on the real path, mirroring
    // AUTH_DEV_BYPASS requiring COGNITO_*.
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

    expect(cfg.AUTH_DEV_BYPASS).toBe(true);
  });

  // ── (c) Real auth path: COGNITO_* trio required ──────────────────────────
  it('fails fast (process.exit(1)) on the real auth path when COGNITO_* vars are absent', async () => {
    process.env = {
      DATABASE_URL: 'postgres://x/y',
      NODE_ENV: 'development',
      // AUTH_DEV_BYPASS intentionally absent (defaults to false)
      // COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID_ALLOWLIST, COGNITO_REQUIRED_SCOPE absent
    };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
