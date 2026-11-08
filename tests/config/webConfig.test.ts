/**
 * Config — WEB_STATIC_DIR (dev-only static web serving).
 *
 *  (a) production + WEB_STATIC_DIR → process.exit(1), error mentions WEB_STATIC_DIR
 *  (b) development + WEB_STATIC_DIR → loads with the value
 *  (c) absent by default
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

function devEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://x/y',
    AUTH_DEV_BYPASS: 'true',
    JUDGE_STUB: 'true',
    PROMOTE_OIDC_DEV_BYPASS: 'true',
    EMBEDDER_STUB: 'true',
  };
}

describe('config WEB_STATIC_DIR', () => {
  it('fails fast when WEB_STATIC_DIR is set under NODE_ENV=production', async () => {
    process.env = { ...validProdEnv(), WEB_STATIC_DIR: '/srv/web' };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadConfig = await loadFresh();

    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('WEB_STATIC_DIR');
  });

  it('allows WEB_STATIC_DIR in development', async () => {
    process.env = { ...devEnv(), WEB_STATIC_DIR: '/srv/web' };
    const loadConfig = await loadFresh();
    expect(loadConfig().WEB_STATIC_DIR).toBe('/srv/web');
  });

  it('is absent by default', async () => {
    process.env = devEnv();
    const loadConfig = await loadFresh();
    expect(loadConfig().WEB_STATIC_DIR).toBeUndefined();
  });
});
