/** Single source of truth for the embedding dimension (Bedrock Titan Text Embeddings V2). */
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** Returns an EMBEDDING_DIM-length vector. MAY throw; callers implement fail-soft. */
  embed(text: string): Promise<number[]>;
}
