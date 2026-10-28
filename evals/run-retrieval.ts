import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "../src/config";
import { closePools, getPool } from "../src/db/pool";
import { getEmbedder } from "../src/embed";
import { loadGolden } from "../src/eval/golden";
import { mean, percentile, recallAtK, reciprocalRank } from "../src/eval/metrics";
import { getReranker } from "../src/retrieve/rerank";
import { pipelineMode, search } from "../src/retrieve/search";
import type { SearchMode } from "../src/retrieve/types";

/**
 * Retrieval eval: for every answerable golden question, run each retrieval mode and measure
 * recall@k, MRR, and latency. No LLM involved, so it is free, fast, and runs in CI.
 *
 *   npm run eval:retrieval                     # print the table
 *   npm run eval:retrieval -- --write-baseline # save numbers to evals/baseline.json
 *   npm run eval:retrieval -- --gate           # exit 1 if worse than the baseline
 */
const args = process.argv.slice(2);
const KS = [1, 3, 5, 10];
const MODES: SearchMode[] = ["vector", "fts", "hybrid", "rerank"];
const pool = getPool();
const embedder = getEmbedder();
// If the app runs without a re-ranker we still measure one, so the ablation table stays complete.
const reranker = getReranker(config.reranker === "none" ? "heuristic" : config.reranker);
const appMode = pipelineMode();
const golden = loadGolden().filter((g) => g.expected_docs.length > 0);
const configKey = `${embedder.name}+${appMode === "rerank" ? reranker.name : "no-rerank"}`;

// Warm-up: the first query pays one-off costs (connection setup, model load) that are not
// representative of steady-state latency.
await search(pool, "warm up", { mode: "rerank", k: 10, embedder, reranker });

type Row = {
  mode: SearchMode;
  recall: Record<number, number>;
  mrr: number;
  p50: number;
  p95: number;
  misses: string[];
  /** recall@1 / recall@5 split by literal vs paraphrased questions. */
  bySubset: Record<"literal" | "paraphrased", { r1: number; r5: number; n: number }>;
};
const rows: Row[] = [];
for (const mode of MODES) {
  const rec: Record<number, number[]> = Object.fromEntries(KS.map((k) => [k, []]));
  const rr: number[] = [];
  const lat: number[] = [];
  const misses: string[] = [];
  const sub = { literal: { r1: [] as number[], r5: [] as number[] }, paraphrased: { r1: [] as number[], r5: [] as number[] } };
  for (const g of golden) {
    const { hits, timings } = await search(pool, g.question, { mode, k: Math.max(...KS), embedder, reranker });
    const paths = hits.map((h) => h.path);
    for (const k of KS) rec[k].push(recallAtK(g.expected_docs, paths, k));
    rr.push(reciprocalRank(g.expected_docs, paths));
    const bucket = sub[g.paraphrased ? "paraphrased" : "literal"];
    bucket.r1.push(recallAtK(g.expected_docs, paths, 1));
    bucket.r5.push(recallAtK(g.expected_docs, paths, 5));
    lat.push(timings.totalMs);
    if (recallAtK(g.expected_docs, paths, 5) < 1) misses.push(`${g.id} ${g.question}  -> got ${[...new Set(paths.slice(0, 5))].join(", ")}`);
  }
  rows.push({
    mode,
    recall: Object.fromEntries(KS.map((k) => [k, mean(rec[k])])),
    mrr: mean(rr),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    misses,
    bySubset: {
      literal: { r1: mean(sub.literal.r1), r5: mean(sub.literal.r5), n: sub.literal.r1.length },
      paraphrased: { r1: mean(sub.paraphrased.r1), r5: mean(sub.paraphrased.r5), n: sub.paraphrased.r1.length },
    },
  });
}

const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
console.log(
  `Retrieval eval: ${golden.length} answerable questions, embedder=${embedder.name}, reranker=${reranker.name}, ` +
    `chunk max=${config.chunkMaxTokens}, app pipeline=${appMode}\n`,
);
console.log("mode     " + KS.map((k) => `  R@${k}`.padStart(7)).join("") + "     MRR   p50 ms  p95 ms");
for (const r of rows) {
  console.log(
    r.mode.padEnd(9) + KS.map((k) => pct(r.recall[k]).padStart(7)).join("") + `   ${r.mrr.toFixed(3)}` + `   ${r.p50.toFixed(1).padStart(6)}  ${r.p95.toFixed(1).padStart(6)}`,
  );
}
const lit = rows[0].bySubset.literal.n, para = rows[0].bySubset.paraphrased.n;
console.log(`\nBy question wording (R@1 / R@5):      literal (n=${lit})     paraphrased (n=${para})`);
for (const r of rows) {
  const b = r.bySubset;
  console.log(`  ${r.mode.padEnd(9)}                     ${pct(b.literal.r1)} / ${pct(b.literal.r5)}     ${pct(b.paraphrased.r1)} / ${pct(b.paraphrased.r5)}`);
}

const best = rows.find((r) => r.mode === appMode)!;
if (best.misses.length) {
  console.log(`\nQuestions where the app pipeline (${appMode}) missed an expected doc in the top 5:`);
  for (const m of best.misses) console.log("  " + m);
}

const summary = {
  config: configKey,
  chunkMaxTokens: config.chunkMaxTokens,
  questions: golden.length,
  appMode,
  modes: Object.fromEntries(rows.map((r) => [r.mode, { recall: r.recall, mrr: r.mrr, p50_ms: r.p50, p95_ms: r.p95, bySubset: r.bySubset }])),
};
mkdirSync("evals/runs", { recursive: true });
writeFileSync(`evals/runs/retrieval-${Date.now()}.json`, JSON.stringify(summary, null, 2));

const BASELINE = "evals/baseline.json";
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
if (args.includes("--write-baseline")) {
  baseline.retrieval ??= {};
  baseline.retrieval[configKey] = { mode: appMode, recall_at_1: best.recall[1], recall_at_5: best.recall[5], mrr: best.mrr, measured_at: new Date().toISOString().slice(0, 10) };
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\nWrote baseline for ${configKey} to ${BASELINE}`);
}
let failed = false;
if (args.includes("--gate")) {
  const b = baseline.retrieval?.[configKey];
  // Allow a small tolerance so harmless reorderings don't fail CI; a real regression is bigger.
  const TOL = 0.02;
  if (!b) console.log(`\n[gate] no baseline for ${configKey}; skipping gate`);
  else if (best.recall[5] < b.recall_at_5 - TOL) {
    console.log(`\n[gate] FAIL: recall@5 ${pct(best.recall[5])} < baseline ${pct(b.recall_at_5)} - ${TOL * 100} pts`);
    failed = true;
  } else console.log(`\n[gate] PASS: recall@5 ${pct(best.recall[5])} (baseline ${pct(b.recall_at_5)})`);
}
await closePools();
process.exit(failed ? 1 : 0);
