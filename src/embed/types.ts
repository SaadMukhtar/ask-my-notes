export interface Embedder {
  /** Stored with every document so we can detect "these vectors came from a different model". */
  readonly name: string;
  readonly dim: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Some models (bge) want queries phrased differently from documents, hence a separate method. */
  embedQuery(text: string): Promise<number[]>;
}

export const EMBED_DIM = 384;
