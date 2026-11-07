/**
 * Judge/review config guards: JUDGE_CONFIDENCE_THRESHOLD, MANDATORY_REVIEW_TYPES,
 * JUDGE_STUB_CONFIDENCE. Same spy pattern as promoteConfig.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIG = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

const BASE = {
  DATABASE_URL: 'postgres://x/y',
  AUTH_DEV_BYPASS: 'true',
  JUDGE_STUB: 'true',
  EMBEDDER_STUB: 'true',
  PROMOTE_OIDC_DEV_BYPASS: 'true',
  AWS_REGION: 'us-east-1',
};

async function load(extra: Record<string, string>) {
  process.env = { ...BASE, ...extra };
  vi.resetModules();
  const mod = await import('../../src/config/index.js');
  return mod.loadConfig;
}

async function expectExit(extra: Record<string, string>) {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const loadConfig = await load(extra);
  expect(() => loadConfig()).toThrow('exit');
  expect(exit).toHaveBeenCalledWith(1);
}

describe('judge config defaults', () => {
  it('applies defaults 0.8 / [decision,constraint,domain_rule] / 0.9', async () => {
    const cfg = (await load({}))();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(cfg.MANDATORY_REVIEW_TYPES).toEqual(['decision', 'constraint', 'domain_rule']);
    expect(cfg.JUDGE_STUB_CONFIDENCE).toBe(0.9);
  });

  it('accepts valid explicit values', async () => {
    const cfg = (
      await load({
        JUDGE_CONFIDENCE_THRESHOLD: '0.5',
        MANDATORY_REVIEW_TYPES: ' gotcha , outcome ',
        JUDGE_STUB_CONFIDENCE: '1',
      })
    )();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(cfg.MANDATORY_REVIEW_TYPES).toEqual(['gotcha', 'outcome']);
    expect(cfg.JUDGE_STUB_CONFIDENCE).toBe(1);
  });

  it('allows an empty MANDATORY_REVIEW_TYPES list', async () => {
    const cfg = (await load({ MANDATORY_REVIEW_TYPES: '' }))();
    expect(cfg.MANDATORY_REVIEW_TYPES).toEqual([]);
  });

  it('ignores JUDGE_STUB_VERDICT (not part of Config)', async () => {
    const cfg = (await load({ JUDGE_STUB_VERDICT: 'accepted' }))();
    expect('JUDGE_STUB_VERDICT' in cfg).toBe(false);
  });
});

describe('judge config guards', () => {
  it.each(['1.5', '-0.1', '', 'abc', '0.8x', 'NaN'])(
    'rejects JUDGE_CONFIDENCE_THRESHOLD=%j',
    async (v) => {
      await expectExit({ JUDGE_CONFIDENCE_THRESHOLD: v });
    },
  );

  it.each(['2', '-1', '', 'abc'])('rejects JUDGE_STUB_CONFIDENCE=%j', async (v) => {
    await expectExit({ JUDGE_STUB_CONFIDENCE: v });
  });

  it('rejects an unknown memory type in MANDATORY_REVIEW_TYPES', async () => {
    await expectExit({ MANDATORY_REVIEW_TYPES: 'decision,foo' });
  });
});

describe('judge config — whitespace tolerance (SEC L-3)', () => {
  it('trims JUDGE_CONFIDENCE_THRESHOLD / JUDGE_STUB_CONFIDENCE before validating', async () => {
    const cfg = (
      await load({ JUDGE_CONFIDENCE_THRESHOLD: ' 0.75 ', JUDGE_STUB_CONFIDENCE: '\t0.9\n' })
    )();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.75);
    expect(cfg.JUDGE_STUB_CONFIDENCE).toBe(0.9);
  });

  it('a whitespace-only threshold is still rejected (never silently 0)', async () => {
    await expectExit({ JUDGE_CONFIDENCE_THRESHOLD: '   ' });
  });
});

describe('judge config — production floor (SEC L-3 / reviewer LOW-1)', () => {
  /** A complete, otherwise-valid production environment (no stubs/bypasses). */
  const PROD = {
    DATABASE_URL: 'postgres://x/y',
    NODE_ENV: 'production',
    AUTH_DEV_BYPASS: 'false',
    COGNITO_USER_POOL_ID: 'us-east-1_abc',
    COGNITO_CLIENT_ID_ALLOWLIST: 'client-1',
    COGNITO_REQUIRED_SCOPE: 'gmemo/mcp',
    JUDGE_STUB: 'false',
    BEDROCK_MODEL_ID: 'model-x',
    EMBEDDER_STUB: 'false',
    BEDROCK_EMBEDDING_MODEL_ID: 'embed-x',
    PROMOTE_OIDC_DEV_BYPASS: 'false',
    GITHUB_OIDC_AUDIENCE: 'gmemo',
    AWS_REGION: 'us-east-1',
  };

  async function loadProd(extra: Record<string, string>) {
    process.env = { ...PROD, ...extra };
    vi.resetModules();
    const mod = await import('../../src/config/index.js');
    return mod.loadConfig;
  }

  async function expectProdExit(extra: Record<string, string>) {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadConfig = await loadProd(extra);
    expect(() => loadConfig()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  }

  it('loads with the defaults (0.8, non-empty mandatory types)', async () => {
    const cfg = (await loadProd({}))();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(cfg.MANDATORY_REVIEW_TYPES.length).toBeGreaterThan(0);
  });

  it('accepts a threshold of exactly 0.5', async () => {
    const cfg = (await loadProd({ JUDGE_CONFIDENCE_THRESHOLD: '0.5' }))();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.5);
  });

  it.each(['0.49', '0', '0.1'])(
    'rejects JUDGE_CONFIDENCE_THRESHOLD=%s in production',
    async (v) => {
      await expectProdExit({ JUDGE_CONFIDENCE_THRESHOLD: v });
    },
  );

  it.each(['', ' , '])('rejects an empty MANDATORY_REVIEW_TYPES=%j in production', async (v) => {
    await expectProdExit({ MANDATORY_REVIEW_TYPES: v });
  });

  it('a low threshold is still allowed outside production', async () => {
    const cfg = (await load({ JUDGE_CONFIDENCE_THRESHOLD: '0.1' }))();
    expect(cfg.JUDGE_CONFIDENCE_THRESHOLD).toBe(0.1);
  });
});
