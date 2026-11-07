/**
 * T012: StubEmbedder unit tests.
 *
 * Verifies the four required properties of the deterministic pseudo-embedder:
 *  1. Determinism: same input always yields the identical vector.
 *  2. Output length equals EMBEDDING_DIM (1024).
 *  3. L2 norm is approximately 1 (unit vector, epsilon = 1e-9).
 *  4. Two distinct inputs produce different vectors.
 */

import { describe, it, expect } from 'vitest';
import { StubEmbedder } from '../../src/embedder/stubEmbedder.js';
import { EMBEDDING_DIM } from '../../src/embedder/embedder.js';

const embedder = new StubEmbedder();

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('StubEmbedder — determinism', () => {
  it('returns identical vectors on repeated calls with the same input', async () => {
    const text = 'Use read-replicas for FTS queries';
    const first = await embedder.embed(text);
    const second = await embedder.embed(text);
    expect(first).toEqual(second);
  });

  it('returns identical vectors on repeated calls with a different input', async () => {
    const text = 'Route recall queries through pgvector';
    const first = await embedder.embed(text);
    const second = await embedder.embed(text);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// Output dimension
// ---------------------------------------------------------------------------

describe('StubEmbedder — output dimension', () => {
  it(`output length is exactly EMBEDDING_DIM (${EMBEDDING_DIM})`, async () => {
    const vec = await embedder.embed('decision: adopt RDS read-replicas');
    expect(vec).toHaveLength(EMBEDDING_DIM);
  });
});

// ---------------------------------------------------------------------------
// L2 normalization (unit vector)
// ---------------------------------------------------------------------------

describe('StubEmbedder — L2 normalization', () => {
  it('output is a unit vector (L2 norm ≈ 1, within 1e-9)', async () => {
    const vec = await embedder.embed('constraint: max body 2000 chars');
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 9);
  });

  it('unit-vector property holds across multiple distinct inputs', async () => {
    const inputs = [
      'pattern: opaque handle = (memory_id, revision)',
      'gotcha: pgvector extension must be enabled before migration',
      'integration_note: Bedrock calls route via VPC PrivateLink',
    ];
    for (const text of inputs) {
      const vec = await embedder.embed(text);
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Distinctness: different inputs → different vectors
// ---------------------------------------------------------------------------

describe('StubEmbedder — distinct inputs yield distinct vectors', () => {
  it('different strings produce different output vectors', async () => {
    const a = await embedder.embed('decision: use Postgres for memory layer');
    const b = await embedder.embed('decision: use DynamoDB for memory layer');
    expect(a).not.toEqual(b);
  });

  it('single-character difference in input still produces a different vector', async () => {
    const a = await embedder.embed('recall');
    const b = await embedder.embed('recalL');
    expect(a).not.toEqual(b);
  });
});
