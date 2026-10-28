import { config } from "../src/config";
import { closePools, getPool } from "../src/db/pool";
import { mean } from "../src/eval/metrics";
import { costUsd } from "../src/llm/pricing";
import type { TraceStep } from "../src/trace";

/**
 * ESTIMATE, not a measurement. Projects Claude's cost per question from offline-baseline traces:
 * it reuses the *measured* number of model calls per question and the *measured* prompt size of each
 * call (estimated as chars / 4), then prices them with assumed output sizes. Real numbers come from
 * `npm run eval:full` with a key; use this only to know the order of magnitude before you spend money.
 *   npm run estimate:cost
 */
const OUT_PLAN = 150; // tokens for a tool-call turn (assumption)
const OUT_ANSWER = 450; // tokens for a final answer incl. some adaptive thinking (assumption)

const { rows } = await getPool().query(
  `SELECT route, steps FROM traces WHERE kind = 'agent' AND model = 'offline-extractive' AND created_at > now() - interval '1 day'`,
);
if (!rows.length) {
  console.log("Run `LLM_PROVIDER=offline npm run eval:full` first; this projects from its traces.");
  process.exit(0);
}
const byRoute: Record<string, { calls: number[]; perQuestion: { cold: number; warm: number }[] }> = {};
for (const r of rows) {
  const calls = (r.steps as TraceStep[]).filter((s) => s.type === "llm");
  const model = r.route === "easy" ? config.routerModel : config.answerModel;
  let cold = 0, warm = 0, prevPrompt = 0;
  calls.forEach((c, i) => {
    const prompt = c.usage?.input ?? 0;
    const out = i === calls.length - 1 ? OUT_ANSWER : OUT_PLAN;
    cold += costUsd(model, { input: prompt, output: out, cacheWrite: 0, cacheRead: 0 });
    // With automatic caching, the part of this prompt that the previous call already sent is read
    // from cache (0.1x) and the new part is written (1.25x).
    warm += costUsd(model, { input: 0, output: out, cacheRead: Math.min(prevPrompt, prompt), cacheWrite: Math.max(0, prompt - prevPrompt) });
    prevPrompt = prompt;
  });
  (byRoute[r.route] ??= { calls: [], perQuestion: [] }).calls.push(calls.length);
  byRoute[r.route].perQuestion.push({ cold, warm });
}
console.log(`ESTIMATE from ${rows.length} offline traces (assumes ${OUT_PLAN} output tokens per tool turn, ${OUT_ANSWER} per answer; router call ~$0.00002 not included)\n`);
for (const [route, v] of Object.entries(byRoute)) {
  const model = route === "easy" ? config.routerModel : config.answerModel;
  console.log(
    `${route.padEnd(5)} -> ${model.padEnd(18)} model calls/question ${mean(v.calls).toFixed(1)}   ` +
      `$/question without caching ${mean(v.perQuestion.map((x) => x.cold)).toFixed(5)}   with caching ${mean(v.perQuestion.map((x) => x.warm)).toFixed(5)}`,
  );
}
const all = Object.values(byRoute).flatMap((v) => v.perQuestion);
const allSonnet = rows.map((r) => {
  const calls = (r.steps as TraceStep[]).filter((s) => s.type === "llm");
  return calls.reduce((s, c, i) => s + costUsd(config.answerModel, { input: c.usage?.input ?? 0, output: i === calls.length - 1 ? OUT_ANSWER : OUT_PLAN, cacheWrite: 0, cacheRead: 0 }), 0);
});
console.log(`\nblended, routed, with caching: $${mean(all.map((x) => x.warm)).toFixed(5)}/question    everything on ${config.answerModel}, no caching: $${mean(allSonnet).toFixed(5)}/question`);
await closePools();
