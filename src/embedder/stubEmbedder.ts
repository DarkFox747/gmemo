// DEV/TEST-ONLY. Deterministic, dependency-free pseudo-embedding. NOT semantic —
// same input always yields the same unit vector; used for reproducible ranking/integration tests.
import { createHash } from 'node:crypto';
import { EMBEDDING_DIM, type Embedder } from './embedder.js';

export class StubEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const out = new Array<number>(EMBEDDING_DIM);
    let block = Buffer.alloc(0);
    let offset = 0;
    let counter = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      if (offset + 4 > block.length) {
        block = createHash('sha256').update(`${text}:${counter++}`).digest(); // 32 bytes → 8 int32
        offset = 0;
      }
      out[i] = block.readInt32BE(offset) / 2147483648; // → [-1, 1)
      offset += 4;
    }
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return out.map((v) => v / norm); // L2-normalized unit vector
  }
}
