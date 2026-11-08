import { logger } from '../observability/logger.js';

/** Single source of truth for the embedding dimension (Bedrock Titan Text Embeddings V2). */
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** Returns an EMBEDDING_DIM-length vector. MAY throw; callers implement fail-soft. */
  embed(text: string): Promise<number[]>;
}

/** Minimal item shape needed to embed a staging item. */
export interface EmbeddableItem {
  id: string;
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  title: string;
  summary: string;
  body: string;
}

/**
 * Fail-soft embedding of a staging item: deprecate has no content change (null,
 * no call); a throwing embedder yields null and logs the item id + error name only.
 */
export async function embedItemFailSoft(
  embedder: Embedder,
  item: EmbeddableItem,
): Promise<number[] | null> {
  if (item.op === 'deprecate') return null;
  try {
    return await embedder.embed(`${item.title}\n${item.summary}\n${item.body}`);
  } catch (err) {
    logger.warn('[promote] embedding failed — writing NULL (fail-soft)', {
      itemId: item.id,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}
