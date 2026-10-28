import type pg from "pg";
import { STOPWORDS, tokenize } from "../embed/text";
import type { Hit } from "./types";

/**
 * Turn a natural-language question into an OR query for Postgres full-text search.
 *
 * Why OR: `plainto_tsquery` / `websearch_to_tsquery` AND every word together, so a question like
 * "how long does the primary have to acknowledge a page" matches nothing unless one chunk has
 * all of those words. With OR, any matching word counts and ts_rank_cd sorts the best matches first.
 * Postgres does the stemming ("acknowledged" -> "acknowledg") when it parses each term.
 */
export function toOrQuery(question: string): string | null {
  const terms = [...new Set(tokenize(question).filter((t) => !STOPWORDS.has(t) && t.length > 1))]
    // keep only characters tsquery accepts, so user input can never break the query syntax
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  return terms.length ? terms.join(" | ") : null;
}

/** Keyword search with Postgres FTS. ts_rank_cd rewards matches that appear close together. */
export async function fullTextSearch(pool: pg.Pool, question: string, k: number): Promise<Hit[]> {
  const q = toOrQuery(question);
  if (!q) return [];
  const { rows } = await pool.query(
    `SELECT c.id, d.path, d.title, c.heading_path, c.content,
            ts_rank_cd(c.tsv, to_tsquery('english', $1), 32) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.tsv @@ to_tsquery('english', $1)
      ORDER BY score DESC, c.id
      LIMIT $2`,
    [q, k],
  );
  return rows.map((r, i) => ({
    chunkId: r.id,
    path: r.path,
    title: r.title,
    headingPath: r.heading_path,
    content: r.content,
    score: Number(r.score),
    signals: { ftsRank: i + 1, ftsScore: Number(r.score) },
  }));
}
