import { config } from "../config";
import { contentTerms, tokenize } from "../embed/text";
import type { Hit } from "./types";

export interface Reranker {
  readonly name: string;
  /** Re-score candidates against the query and return them best-first. */
  rerank(query: string, hits: Hit[]): Promise<Hit[]>;
}

/** Identifiers like INC-2041, ADR-007, max_client_conn, s3:PutObject: when the user types one, an exact match matters a lot. */
function identifiers(text: string): string[] {
  return (text.match(/[A-Za-z0-9]+(?:[-_:][A-Za-z0-9]+)+|\b[A-Za-z]*\d[A-Za-z0-9.]*\b/g) ?? []).map((s) => s.toLowerCase());
}

function bigrams(terms: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < terms.length; i++) out.add(`${terms[i - 1]} ${terms[i]}`);
  return out;
}

/**
 * A transparent, feature-based re-ranker. No model, so you can read exactly why a chunk moved.
 *
 * First-stage retrieval is optimised for recall (find everything plausibly relevant); a re-ranker
 * looks at each (query, chunk) pair more carefully and fixes the order. This one combines:
 *   - the fused RRF score (what retrieval already believed),
 *   - IDF-weighted query-term coverage: does the chunk contain *most* of the question's rare words?
 *   - heading coverage: do the question's words appear in the chunk's headings?
 *   - phrase overlap: shared word pairs, a cheap proximity signal,
 *   - exact identifier matches (INC-2041, max_client_conn).
 * The weights were set by reasoning, not tuned on the golden set, to avoid overfitting the eval.
 */
export class HeuristicReranker implements Reranker {
  readonly name = "heuristic-v1";

  async rerank(query: string, hits: Hit[]): Promise<Hit[]> {
    if (hits.length === 0) return hits;
    const qTerms = [...new Set(contentTerms(query))];
    const qIds = identifiers(query);
    const qBigrams = bigrams(contentTerms(query));
    const docs = hits.map((h) => {
      const terms = contentTerms(`${h.headingPath}\n${h.content}`);
      return { terms: new Set(terms), bigrams: bigrams(terms), heading: new Set(contentTerms(h.headingPath)), lower: `${h.headingPath}\n${h.content}`.toLowerCase() };
    });
    // IDF over the candidate set: a term that appears in every candidate tells us nothing.
    const idf = new Map(
      qTerms.map((t) => {
        const df = docs.filter((d) => d.terms.has(t)).length;
        return [t, Math.log(1 + hits.length / (1 + df))];
      }),
    );
    const idfTotal = [...idf.values()].reduce((a, b) => a + b, 0) || 1;
    const maxRrf = Math.max(...hits.map((h) => h.signals.rrf ?? h.score)) || 1;

    const scored = hits.map((h, i) => {
      const d = docs[i];
      const coverage = qTerms.reduce((s, t) => s + (d.terms.has(t) ? idf.get(t)! : 0), 0) / idfTotal;
      const headingCov = qTerms.length ? qTerms.filter((t) => d.heading.has(t)).length / qTerms.length : 0;
      const phrase = qBigrams.size ? [...qBigrams].filter((b) => d.bigrams.has(b)).length / qBigrams.size : 0;
      const idMatch = qIds.length ? qIds.filter((id) => d.lower.includes(id)).length / qIds.length : 0;
      const prior = (h.signals.rrf ?? h.score) / maxRrf;
      const score = 0.35 * prior + 0.35 * coverage + 0.1 * headingCov + 0.1 * phrase + 0.1 * idMatch;
      return { ...h, score, signals: { ...h.signals, rerank: score } };
    });
    return scored.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  }
}

/**
 * Cross-encoder re-ranker (local, transformers.js). A cross-encoder reads the query and the chunk
 * *together* and outputs one relevance score, which is far more accurate than comparing two
 * separately computed embeddings, but too slow to run over the whole corpus. Hence: retrieve ~30
 * candidates cheaply, cross-encode only those.
 * Not executed in the build sandbox (Hugging Face blocked); see DECISIONS.md D-006.
 */
export class CrossEncoderReranker implements Reranker {
  readonly name: string;
  private loaded: Promise<{ tok: any; model: any }> | null = null;

  constructor(private readonly modelId = "Xenova/ms-marco-MiniLM-L-6-v2") {
    this.name = modelId;
  }

  private load() {
    this.loaded ??= import("@huggingface/transformers").then(async (t) => ({
      tok: await t.AutoTokenizer.from_pretrained(this.modelId),
      model: await t.AutoModelForSequenceClassification.from_pretrained(this.modelId, { dtype: "q8" }),
    }));
    return this.loaded;
  }

  async rerank(query: string, hits: Hit[]): Promise<Hit[]> {
    if (hits.length === 0) return hits;
    const { tok, model } = await this.load();
    const inputs = tok(new Array(hits.length).fill(query), {
      text_pair: hits.map((h) => `${h.headingPath}\n${h.content}`),
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const scores: number[] = (logits.tolist() as number[][]).map((row) => row[0]);
    return hits
      .map((h, i) => ({ ...h, score: scores[i], signals: { ...h.signals, rerank: scores[i] } }))
      .sort((a, b) => b.score - a.score);
  }
}

export class NoopReranker implements Reranker {
  readonly name = "none";
  async rerank(_q: string, hits: Hit[]) {
    return hits;
  }
}

export function getReranker(kind: string = config.reranker): Reranker {
  if (kind === "cross-encoder") return new CrossEncoderReranker();
  if (kind === "heuristic") return new HeuristicReranker();
  return new NoopReranker();
}

export { tokenize };
