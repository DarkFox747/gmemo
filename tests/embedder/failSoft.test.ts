/**
 * T013 / T009 migration: BedrockEmbedder fail-soft contract.
 *
 * Migrated to the options-object constructor (T009): injects a throwing fake client
 * via options.client instead of relying on the deferred ENOTIMPLEMENTED throw.
 * The fail-soft contract is PRESERVED and re-asserted:
 *
 *  1. BedrockEmbedder.embed() REJECTS; it does NOT swallow errors.
 *  2. ThrowingEmbedder (a minimal test helper) shows the Embedder interface
 *     deliberately permits throwing implementations.
 *  3. The fail-soft pattern (try/catch → null) is the CALLER's responsibility;
 *     the caller yields null without the error escaping.
 *
 * Design ref: src/embedder/bedrockEmbedder.ts — "Callers implement fail-soft."
 */

import { describe, it, expect, vi } from 'vitest';
import { BedrockEmbedder } from '../../src/embedder/bedrockEmbedder.js';
import { StubEmbedder } from '../../src/embedder/stubEmbedder.js';
import { EMBEDDING_DIM, type Embedder } from '../../src/embedder/embedder.js';
import type { BedrockInvoker } from '../../src/bedrock/client.js';

// ---------------------------------------------------------------------------
// Throwing fake client — injected to prove BedrockEmbedder propagates errors
// ---------------------------------------------------------------------------

/**
 * Fake BedrockInvoker whose send() always rejects.
 * Injected via options.client; avoids live AWS and the deferred throw path.
 */
function makeThrowingClient(): BedrockInvoker {
  return {
    send: vi.fn().mockRejectedValue(new Error('BedrockEmbedder.invokeModel not implemented (deferred)')),
  };
}

// ---------------------------------------------------------------------------
// ThrowingEmbedder — minimal helper: always rejects
// ---------------------------------------------------------------------------

/** Test-only Embedder that always rejects, used to verify caller fail-soft patterns. */
class ThrowingEmbedder implements Embedder {
  async embed(_text: string): Promise<number[]> {
    throw new Error('ThrowingEmbedder: always fails');
  }
}

// ---------------------------------------------------------------------------
// embedOrNull — representative caller-side fail-soft pattern
// ---------------------------------------------------------------------------

/**
 * The fail-soft contract lives HERE (in the caller), not inside the embedder.
 * The embedder MAY throw; this caller absorbs the error and returns null.
 * Downstream logic must handle null (e.g., skip semantic scoring, fall back to BM25).
 */
async function embedOrNull(embedder: Embedder, text: string): Promise<number[] | null> {
  try {
    return await embedder.embed(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// BedrockEmbedder — rejects; does NOT swallow errors
// ---------------------------------------------------------------------------

describe('BedrockEmbedder — propagates errors to callers (injected throwing client)', () => {
  it('embed() rejects when the injected client rejects', async () => {
    const bedrock = new BedrockEmbedder({
      modelId: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      client: makeThrowingClient(),
    });
    await expect(bedrock.embed('x')).rejects.toThrow();
  });

  it('embed() does NOT silently resolve — never produces an array on failure', async () => {
    const bedrock = new BedrockEmbedder({
      modelId: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      client: makeThrowingClient(),
    });
    let resolved = false;
    try {
      await bedrock.embed('x');
      resolved = true;
    } catch {
      // expected path
    }
    expect(resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ThrowingEmbedder — demonstrates the Embedder interface permits throwing
// ---------------------------------------------------------------------------

describe('ThrowingEmbedder — Embedder interface permits throwing implementations', () => {
  it('embed() always rejects with the expected message', async () => {
    const thrower = new ThrowingEmbedder();
    await expect(thrower.embed('any text')).rejects.toThrow('ThrowingEmbedder: always fails');
  });
});

// ---------------------------------------------------------------------------
// Caller fail-soft pattern: try/catch → null
// ---------------------------------------------------------------------------

describe('embedOrNull — fail-soft contract lives in the caller', () => {
  it('returns null when ThrowingEmbedder fails', async () => {
    const result = await embedOrNull(new ThrowingEmbedder(), 'any text');
    expect(result).toBeNull();
  });

  it('returns null when BedrockEmbedder fails (injected throwing client)', async () => {
    const bedrock = new BedrockEmbedder({
      modelId: 'amazon.titan-embed-text-v2:0',
      region: 'us-east-1',
      client: makeThrowingClient(),
    });
    const result = await embedOrNull(bedrock, 'x');
    expect(result).toBeNull();
  });

  it('error does NOT escape the caller — no unhandled rejection propagates', async () => {
    let threw = false;
    try {
      await embedOrNull(new ThrowingEmbedder(), 'some text');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('resolves normally when embed succeeds — embedOrNull is transparent on the happy path', async () => {
    const result = await embedOrNull(new StubEmbedder(), 'a working embedder');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(EMBEDDING_DIM);
  });
});
