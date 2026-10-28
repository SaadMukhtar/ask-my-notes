import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "../src/config";
import { closePools, getPool } from "../src/db/pool";
import { getEmbedder } from "../src/embed";
import { runFullEval, printSummary, summarise, pass } from "../src/eval/full";
import { loadGolden } from "../src/eval/golden";
import { getLLM } from "../src/llm/client";
import { verifierName } from "../src/agent/agent";
import { pipelineMode } from "../src/retrieve/search";

/**
 * End-to-end eval: run the agent on all 50 golden questions, grade every answer, report pass rate,
 * refusal accuracy, latency, and cost.
 *
 *   npm run eval:full                       # uses LLM_PROVIDER from .env
 *   LLM_PROVIDER=offline npm run eval:full  # extractive baseline, no key needed
 *   npm run eval:full -- --gate             # exit 1 if pass rate drops below the baseline
 *   npm run eval:full -- --write-baseline   # record this run as the baseline
 *   npm run eval:full -- --no-judge         # skip the LLM judge (deterministic grading only)
 *   npm run eval:full -- --only q01,q02     # subset
 */
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const golden = loadGolden().filter((g) => !only || only.has(g.id));
const llm = getLLM();
const useJudge = llm.provider === "anthropic" && !args.includes("--no-judge");
const configKey = `${llm.provider === "offline" ? "offline-baseline" : `claude:${config.answerModel}+${config.routerModel}`}|${getEmbedder().name}|${pipelineMode()}|verifier=${verifierName(llm)}`;

console.log(`Full eval: ${golden.length} questions, config ${configKey}, judge ${useJudge ? config.answerModel : "off"}`);
const pool = getPool();
const rows = await runFullEval(pool, golden, { judgeLLM: useJudge ? llm : undefined, log: (s) => console.log("  " + s) });
const summary = summarise(configKey, rows, golden);
printSummary(summary);

const failed = rows.filter((r) => !pass(r));
if (failed.length) {
  console.log(`\nFailures (${failed.length}):`);
  for (const r of failed) console.log(`  ${r.id} [${r.type}] ${r.question}\n     det: ${r.det.reasons.join("; ") || "ok"}${r.judge ? `   judge: ${r.judge.verdict} (${r.judge.reasoning})` : ""}`);
}

mkdirSync("evals/runs", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runFile = `evals/runs/full-${stamp}.jsonl`;
writeFileSync(runFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(`evals/runs/full-${stamp}.summary.json`, JSON.stringify(summary, null, 2));
console.log(`\nRows saved to ${runFile} (re-grade without re-running: npm run eval:regrade -- ${runFile})`);

const BASELINE = "evals/baseline.json";
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
let exit = 0;
if (args.includes("--write-baseline") && !only) {
  baseline.full ??= {};
  baseline.full[configKey] = {
    pass_rate: summary.passRate, pass_rate_deterministic: summary.passRateDeterministic, pass_rate_judge: summary.passRateJudge,
    p95_ms: summary.latency.p95Ms, cost_per_question_usd: summary.cost.perQuestionUsd, n: summary.n, measured_at: stamp.slice(0, 10),
  };
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Wrote baseline for ${configKey}`);
}
if (args.includes("--gate")) {
  const b = baseline.full?.[configKey];
  // Offline runs are deterministic: any drop is a real regression. LLM runs vary run to run, so allow 3 questions.
  const tol = llm.provider === "offline" ? 0 : 3 / summary.n;
  if (!b) console.log(`[gate] no baseline for ${configKey}; skipping`);
  else if (summary.passRate + 1e-9 < b.pass_rate - tol) {
    console.log(`[gate] FAIL: pass rate ${(summary.passRate * 100).toFixed(1)}% < baseline ${(b.pass_rate * 100).toFixed(1)}% (tolerance ${(tol * 100).toFixed(1)} pts)`);
    exit = 1;
  } else console.log(`[gate] PASS: pass rate ${(summary.passRate * 100).toFixed(1)}% (baseline ${(b.pass_rate * 100).toFixed(1)}%)`);
}
await closePools();
process.exit(exit);
