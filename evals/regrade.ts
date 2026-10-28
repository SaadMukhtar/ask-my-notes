import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../src/config";
import { judgeRow, pass, printSummary, summarise, type EvalRow } from "../src/eval/full";
import { gradeDeterministic } from "../src/eval/grade";
import { loadGolden } from "../src/eval/golden";
import { getLLM } from "../src/llm/client";

/**
 * Replay: re-grade a saved eval run without re-running the agent. Use it after you edit the golden
 * set's must_include lists or the judge rubric: it costs nothing (deterministic) or only judge calls.
 *   npm run eval:regrade -- evals/runs/full-<stamp>.jsonl [--judge]
 */
const [file, ...rest] = process.argv.slice(2);
if (!file) throw new Error("usage: npm run eval:regrade -- evals/runs/full-<stamp>.jsonl [--judge]");
const golden = loadGolden();
const byId = new Map(golden.map((g) => [g.id, g]));
const rows: EvalRow[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const llm = rest.includes("--judge") ? getLLM() : null;
for (const r of rows) {
  const g = byId.get(r.id);
  if (!g) continue;
  r.det = gradeDeterministic(g, { answer: r.answer, refused: r.refused, citedPaths: r.citedPaths });
  if (llm) r.judge = await judgeRow(llm, config.answerModel, g, r);
}
const out = file.replace(/\.jsonl$/, ".regraded.jsonl");
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
printSummary(summarise(`regrade of ${file}`, rows, golden.filter((g) => rows.some((r) => r.id === g.id))));
console.log(`\n${rows.filter(pass).length}/${rows.length} pass. Saved ${out}`);
