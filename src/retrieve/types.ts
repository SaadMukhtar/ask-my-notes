export interface Hit {
  chunkId: number;
  path: string;
  title: string;
  headingPath: string;
  content: string;
  /** Score from whichever stage produced this list (cosine, ts_rank, RRF, or re-rank score). */
  score: number;
  /** Per-retriever detail, kept so you can see *why* something ranked where it did. */
  signals: { vectorRank?: number; vectorScore?: number; ftsRank?: number; ftsScore?: number; rrf?: number; rerank?: number };
}

export type SearchMode = "vector" | "fts" | "hybrid" | "rerank";
