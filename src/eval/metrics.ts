/**
 * Retrieval metrics, computed at the *document* level over the top-k *chunks*.
 * Why documents: chunk ids change whenever you change chunk size, which would invalidate the
 * golden set. "Did the right note show up in what the model saw?" is the question that matters.
 */

/** Fraction of expected doc slots covered by the retrieved paths. Each slot may be "a|b". */
export function recallAtK(expected: string[], retrievedPaths: string[], k: number): number {
  if (expected.length === 0) return NaN;
  const top = new Set(retrievedPaths.slice(0, k));
  const found = expected.filter((slot) => slot.split("|").some((p) => top.has(p))).length;
  return found / expected.length;
}

/** 1 / rank of the first chunk from any expected doc (0 if none). Rewards putting it first. */
export function reciprocalRank(expected: string[], retrievedPaths: string[]): number {
  const all = new Set(expected.flatMap((s) => s.split("|")));
  const i = retrievedPaths.findIndex((p) => all.has(p));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function mean(xs: number[]): number {
  const v = xs.filter((x) => !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Nearest-rank percentile, e.g. percentile(latencies, 95) for p95. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
