import { config } from "../config";
import { HashEmbedder } from "./hash";
import { TransformersEmbedder } from "./transformers";
import type { Embedder } from "./types";

export type { Embedder } from "./types";

let cached: Embedder | undefined;

export function getEmbedder(kind: string = config.embedder): Embedder {
  if (cached && (kind === "hash") === cached instanceof HashEmbedder) return cached;
  cached = kind === "hash" ? new HashEmbedder() : new TransformersEmbedder();
  return cached;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
