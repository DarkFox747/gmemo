import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBEDDING_DIM, type Embedder } from './embedder.js';
import { makeBedrockRuntimeClient, sendWithTimeout, type BedrockInvoker } from '../bedrock/client.js';

export interface BedrockEmbedderOptions {
  modelId: string;
  region: string;
  maxAttempts?: number;
  timeoutMs?: number;
  /**
   * Optional client injection seam. When provided, skips real BedrockRuntimeClient
   * construction — used in tests to inject a { send: vi.fn() } fake without live AWS.
   */
  client?: BedrockInvoker;
}

export class BedrockEmbedder implements Embedder {
  private readonly modelId: string;
  private readonly client: BedrockInvoker;
  private readonly timeoutMs: number;

  constructor({ modelId, region, maxAttempts = 3, timeoutMs = 15000, client }: BedrockEmbedderOptions) {
    this.modelId = modelId;
    this.timeoutMs = timeoutMs;
    this.client = client ?? makeBedrockRuntimeClient({ region, maxAttempts });
  }

  async embed(text: string): Promise<number[]> {
    // NOTE: unlike BedrockJudge (fail-CLOSED to a valid verdict), this does NOT swallow errors —
    // a fabricated vector would silently corrupt semantic search. Callers implement fail-soft.
    return this.invokeModel(text);
  }

  private async invokeModel(text: string): Promise<number[]> {
    const payload = {
      inputText: text,
      dimensions: EMBEDDING_DIM,
      normalize: true,
    };
    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

    const res = (await sendWithTimeout(this.client, command, this.timeoutMs)) as {
      body: Uint8Array;
    };
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: unknown };
    const embedding = json.embedding;

    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `BedrockEmbedder: expected ${EMBEDDING_DIM}-dim vector, got ${
          Array.isArray(embedding) ? String(embedding.length) : typeof embedding
        }`,
      );
    }

    // Guard against NaN/Infinity values poisoning pgvector — a non-finite element
    // must never reach the DB. Throw here so the caller's fail-soft kicks in.
    for (const val of embedding as unknown[]) {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error('BedrockEmbedder: embedding contains non-finite value');
      }
    }

    return embedding as number[];
  }
}
