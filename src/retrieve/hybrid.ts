import type { Hit } from "./types";

/**
 * Reciprocal Rank Fusion: score(chunk) = sum over lists of 1 / (k + rank).
 *
 * Why RRF and not "add the scores": cosine similarity (0..1) and ts_rank (0..~0.1, unbounded)
 * live on different scales, so adding them lets one retriever drown out the other. RRF only uses
 * ranks, so it needs no tuning or normalisation. k = 60 is the constant from the original paper
 * (Cormack et al., 2009); it dampens the gap between rank 1 and rank 2.
 */
export function reciprocalRankFusion(lists: Hit[][], k = 60): Hit[] {
  const fused = new Map<number, Hit>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const prev = fused.get(hit.chunkId);
      const add = 1 / (k + i + 1);
      if (prev) {
        prev.score += add;
        prev.signals = { ...prev.signals, ...hit.signals };
      } else {
        fused.set(hit.chunkId, { ...hit, score: add, signals: { ...hit.signals } });
      }
    });
  }
  const out = [...fused.values()].sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  for (const h of out) h.signals.rrf = h.score;
  return out;
}
