import type { Embedder } from "./types";
import { EMBED_DIM } from "./types";

// bge models are trained with this instruction in front of queries (not documents).
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * Local neural embedder using transformers.js (ONNX runtime in Node). No API key, no per-call cost.
 * First use downloads ~35 MB of weights from Hugging Face into the transformers.js cache.
 *
 * Model: BAAI bge-small-en-v1.5 (384 dims). Small, fast on CPU, and strong on retrieval
 * benchmarks for its size. Uses CLS pooling, per the model card.
 */
export class TransformersEmbedder implements Embedder {
  readonly name: string;
  readonly dim = EMBED_DIM;
  // The pipeline type from transformers.js is very wide; we only call it, so keep it loose.
  private extractor: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(private readonly model = "Xenova/bge-small-en-v1.5") {
    this.name = model;
  }

  private load() {
    if (!this.extractor) {
      this.extractor = import("@huggingface/transformers").then(
        // q8 = 8-bit quantised weights: ~4x smaller and faster, with a tiny accuracy cost.
        ({ pipeline }) => pipeline("feature-extraction", this.model, { dtype: "q8" }) as never,
      );
    }
    return this.extractor;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const extract = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const t = await extract(batch, { pooling: "cls", normalize: true });
      out.push(...t.tolist());
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embedDocuments([BGE_QUERY_PREFIX + text]);
    return v;
  }
}
