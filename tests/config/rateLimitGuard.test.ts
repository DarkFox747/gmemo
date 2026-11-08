/**
 * Config prod guard — RATE_LIMIT_ENABLED.
 *
 *  (a) complete valid prod env + RATE_LIMIT_ENABLED=false → process.exit(1), error mentions RATE_LIMIT_ENABLED
 *  (b) same prod env without RATE_LIMIT_ENABLED          → loads with RATE_LIMIT_ENABLED=true
 *  (c) development + stubs + RATE_LIMIT_ENABLED=false    → loads with RATE_LIMIT_ENABLED=false
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

async function loadFresh(): Promise<() => ReturnType<typeof import('../../src/config/index.js').loadConfig>> {
  vi.resetModules();
  const mod = await import('../../src/config/index.js');
  return mod.loadConfig;
}

/** Otherwise-complete valid production env: only the rate-limit flag varies. */
function validProdEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x/y',
    COGNITO_USER_POOL_ID: 'us-east-1_abc123',
    COGNITO_CLIENT_ID_ALLOWLIST: 'client-1',
    COGNITO_REQUIRED_SCOPE: 'gmemo.memory/read',
    BEDROCK_MODEL_ID: 'model-id',
    BEDROCK_EMBEDDING_MODEL_ID: 'embed-model-id',
    AWS_REGION: 'us-east-1',
    GITHUB_OIDC_AUDIENCE: 'gmemo',
  };
}

describe('config prod guard (RATE_LIMIT_ENABLED)', () => {
  it('fails fast (process.exit(1)) when RATE_LIMIT_ENABLED=false and NODE_ENV=production', async () => {
    process.env = { ...validProdEnv(), RATE_LIMIT_ENABLED: 'false' };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('RATE_LIMIT_ENABLED');
  });

  it('loads with RATE_LIMIT_ENABLED=true by default in production', async () => {
    process.env = validProdEnv();

    const loadConfig = await loadFresh();

    expect(loadConfig().RATE_LIMIT_ENABLED).toBe(true);
  });

  it('allows RATE_LIMIT_ENABLED=false in development', async () => {
    process.env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x/y',
      AUTH_DEV_BYPASS: 'true',
      JUDGE_STUB: 'true',
      PROMOTE_OIDC_DEV_BYPASS: 'true',
      EMBEDDER_STUB: 'true',
      RATE_LIMIT_ENABLED: 'false',
    };

    const loadConfig = await loadFresh();

    expect(loadConfig().RATE_LIMIT_ENABLED).toBe(false);
  });
});

describe('config /api rate limit', () => {
  const devEnv = () => ({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://x/y',
    AUTH_DEV_BYPASS: 'true',
    JUDGE_STUB: 'true',
    PROMOTE_OIDC_DEV_BYPASS: 'true',
    EMBEDDER_STUB: 'true',
  });

  it('defaults to 60000 ms window and 120 requests', async () => {
    process.env = devEnv();
    const cfg = (await loadFresh())();
    expect(cfg.RATE_LIMIT_API_WINDOW_MS).toBe(60000);
    expect(cfg.RATE_LIMIT_API_MAX).toBe(120);
  });

  it('fails fast when RATE_LIMIT_API_MAX=0', async () => {
    process.env = { ...devEnv(), RATE_LIMIT_API_MAX: '0' };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('RATE_LIMIT_API_MAX');
  });

  it('production guard still forbids RATE_LIMIT_ENABLED=false (covers /api)', async () => {
    process.env = { ...validProdEnv(), RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_API_MAX: '50' };
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
  });
});
