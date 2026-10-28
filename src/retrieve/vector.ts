import type pg from "pg";
import { toPgVector } from "../db/pool";
import type { Hit } from "./types";

/**
 * Semantic search: the k chunks whose embeddings are closest to the query embedding.
 * `<=>` is pgvector's cosine *distance* (1 - cosine similarity), so we ORDER BY it ascending
 * and report 1 - distance as a similarity score.
 */
export async function vectorSearch(pool: pg.Pool, queryVec: number[], k: number): Promise<Hit[]> {
  const { rows } = await pool.query(
    `SELECT c.id, d.path, d.title, c.heading_path, c.content, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [toPgVector(queryVec), k],
  );
  return rows.map((r, i) => ({
    chunkId: r.id,
    path: r.path,
    title: r.title,
    headingPath: r.heading_path,
    content: r.content,
    score: Number(r.score),
    signals: { vectorRank: i + 1, vectorScore: Number(r.score) },
  }));
}
