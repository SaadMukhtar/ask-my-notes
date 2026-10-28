import type { Embedder } from "./types";
import { EMBED_DIM } from "./types";
import { contentTerms } from "./text";

/**
 * A "hashing trick" embedder: no neural network, no download.
 *
 * Each text becomes a bag of features (stemmed words, word pairs, and character trigrams). Every
 * feature is hashed to one of 384 slots with a +1/-1 sign, the counts are log-scaled, and the
 * vector is L2-normalised so cosine similarity is a dot product.
 *
 * What it captures: shared words and word fragments ("rotation" ~ "rotate").
 * What it misses: meaning. "page the secondary" and "escalate to backup" share no features,
 * so they score ~0. That is exactly the gap a neural embedder (and hybrid search) closes.
 *
 * Why it exists: the build sandbox could not download model weights, and CI benefits from a
 * fully deterministic embedder. See docs/DECISIONS.md.
 */
export class HashEmbedder implements Embedder {
  readonly name = "hash-v1";
  readonly dim = EMBED_DIM;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  embed(text: string): number[] {
    const v = new Float64Array(this.dim);
    const terms = contentTerms(text);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const slot = h % this.dim;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[slot] += sign * weight;
    };
    terms.forEach((t, i) => {
      add(`w:${t}`, 1);
      if (i > 0) add(`b:${terms[i - 1]}_${t}`, 0.5);
      const padded = `^${t}$`;
      for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, 0.25);
    });
    // log scaling: a word repeated 10 times should not dominate the vector.
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      v[i] = Math.sign(v[i]) * Math.log1p(Math.abs(v[i]));
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
