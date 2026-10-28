import type pg from "pg";
import { config } from "../config";
import { getEmbedder, type Embedder } from "../embed";
import { fullTextSearch } from "./fulltext";
import { reciprocalRankFusion } from "./hybrid";
import { getReranker, type Reranker } from "./rerank";
import type { Hit, SearchMode } from "./types";

export interface SearchOptions {
  mode?: SearchMode;
  /** How many results to return. */
  k?: number;
  /** How many candidates each first-stage retriever fetches before fusion / re-ranking. */
  candidates?: number;
  embedder?: Embedder;
  reranker?: Reranker;
}

export interface SearchResult {
  hits: Hit[];
  timings: { embedMs: number; vectorMs: number; ftsMs: number; rerankMs: number; totalMs: number };
}

let warnedModel = false;

/** The mode the app uses: re-rank only when a re-ranker is configured (see DECISIONS.md D-006). */
export function pipelineMode(): SearchMode {
  return config.reranker === "none" ? "hybrid" : "rerank";
}

/**
 * The full retrieval pipeline:
 *   question -> [embed] -> vector top-N  \
 *                                         > RRF fusion -> re-rank -> top k
 *   question -> keyword (FTS) top-N      /
 * `mode` lets the eval measure each stage on its own (vector only, FTS only, hybrid, hybrid + re-rank).
 */
export async function search(pool: pg.Pool, question: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const mode = opts.mode ?? pipelineMode();
  const k = opts.k ?? 5;
  const n = opts.candidates ?? 30;
  const embedder = opts.embedder ?? getEmbedder();
  const t0 = performance.now();
  const timings = { embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 };

  if (!warnedModel) {
    warnedModel = true;
    const { rows } = await pool.query("SELECT DISTINCT embed_model FROM documents");
    const models = rows.map((r) => r.embed_model);
    if (models.length && !models.includes(embedder.name)) {
      // Vectors from different models live in different spaces; comparing them is meaningless.
      console.warn(`[search] index was built with ${models.join(", ")} but the query embedder is ${embedder.name}. Re-run \`npm run ingest\`.`);
    }
  }

  const runVector = async () => {
    const e0 = performance.now();
    const qv = await embedder.embedQuery(question);
    timings.embedMs = performance.now() - e0;
    const v0 = performance.now();
    const { vectorSearch } = await import("./vector");
    const hits = await vectorSearch(pool, qv, n);
    timings.vectorMs = performance.now() - v0;
    return hits;
  };
  const runFts = async () => {
    const f0 = performance.now();
    const hits = await fullTextSearch(pool, question, n);
    timings.ftsMs = performance.now() - f0;
    return hits;
  };

  let hits: Hit[];
  if (mode === "vector") hits = await runVector();
  else if (mode === "fts") hits = await runFts();
  else {
    const [v, f] = await Promise.all([runVector(), runFts()]);
    hits = reciprocalRankFusion([v, f]);
    if (mode === "rerank") {
      const r0 = performance.now();
      hits = await (opts.reranker ?? getReranker()).rerank(question, hits.slice(0, n));
      timings.rerankMs = performance.now() - r0;
    }
  }
  timings.totalMs = performance.now() - t0;
  return { hits: hits.slice(0, k), timings };
}
