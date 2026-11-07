/**
 * T007: BedrockEmbedder.invokeModel — injected fake client (no live AWS).
 *
 * Uses the injection seam (options.client) to pass a { send: vi.fn() } fake,
 * exactly as described in the design doc and mirroring the CognitoVerifier pattern.
 * No vi.mock of the SDK is required; command inputs are directly assertable.
 *
 * Coverage:
 *  - Happy path: returns a 1024-length array; sent InvokeModelCommand has correct
 *    modelId and decoded body { inputText, dimensions: 1024, normalize: true }.
 *  - Dimension mismatch (length 512) → embed() rejects.
 *  - AWS error (send rejects) → embed() rejects (no fabricated vector).
 *  - Malformed body (non-JSON) → embed() rejects.
 *  - Malformed body (missing embedding field) → embed() rejects.
 */

import { describe, it, expect, vi } from 'vitest';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockEmbedder } from '../../src/embedder/bedrockEmbedder.js';
import { EMBEDDING_DIM } from '../../src/embedder/embedder.js';
import type { BedrockInvoker } from '../../src/bedrock/client.js';

const MODEL_ID = 'amazon.titan-embed-text-v2:0';

/** Builds a Uint8Array response body containing the given embedding array. */
function encodeEmbedBody(embedding: number[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ embedding }));
}

/** Builds a 1024-element embedding with finite values. */
function makeEmbedding(len: number): number[] {
  return Array.from({ length: len }, (_, i) => (i + 1) / (len + 1));
}

describe('BedrockEmbedder.invokeModel — injected fake (no real AWS)', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns a 1024-length array on success', async () => {
    const embedding = makeEmbedding(EMBEDDING_DIM);
    const send = vi.fn().mockResolvedValue({ body: encodeEmbedBody(embedding) });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    const result = await embedder.embed('hello world');

    expect(result).toHaveLength(EMBEDDING_DIM);
  });

  it('sends an InvokeModelCommand with the correct modelId and decoded body', async () => {
    const embedding = makeEmbedding(EMBEDDING_DIM);
    const send = vi.fn().mockResolvedValue({ body: encodeEmbedBody(embedding) });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await embedder.embed('hello world');

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0] as InvokeModelCommand;
    expect(command).toBeInstanceOf(InvokeModelCommand);
    expect(command.input.modelId).toBe(MODEL_ID);

    // The body is a TextEncoder-encoded JSON payload; decode and assert.
    const decoded = JSON.parse(
      new TextDecoder().decode(command.input.body as Uint8Array),
    ) as unknown;
    expect(decoded).toEqual({
      inputText: 'hello world',
      dimensions: EMBEDDING_DIM,
      normalize: true,
    });
  });

  // ── Error paths — all must reject (fail-soft is the caller's responsibility) ──

  it('rejects when embedding has wrong dimension (512 instead of 1024)', async () => {
    const embedding = makeEmbedding(512);
    const send = vi.fn().mockResolvedValue({ body: encodeEmbedBody(embedding) });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await expect(embedder.embed('hello')).rejects.toThrow();
  });

  it('rejects when send throws an AWS error (ThrottlingException)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ThrottlingException'));
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await expect(embedder.embed('hello')).rejects.toThrow('ThrottlingException');
  });

  it('rejects when body is not valid JSON', async () => {
    const send = vi.fn().mockResolvedValue({ body: new TextEncoder().encode('not-json!!!') });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await expect(embedder.embed('hello')).rejects.toThrow();
  });

  it('rejects when body is valid JSON but missing the embedding field', async () => {
    const send = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ other_field: [1, 2, 3] })),
    });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await expect(embedder.embed('hello')).rejects.toThrow();
  });

  it('rejects when a 1024-length embedding contains a NaN element (non-finite guard, REQ-02)', async () => {
    // A valid-length vector with one NaN must be rejected — a non-finite element
    // must never reach pgvector and would silently corrupt semantic search.
    const embedding = makeEmbedding(EMBEDDING_DIM);
    embedding[42] = NaN;
    const send = vi.fn().mockResolvedValue({ body: encodeEmbedBody(embedding) });
    const client: BedrockInvoker = { send };
    const embedder = new BedrockEmbedder({ modelId: MODEL_ID, region: 'us-east-1', client });

    await expect(embedder.embed('hello')).rejects.toThrow();
  });
});
