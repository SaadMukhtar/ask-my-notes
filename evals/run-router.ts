import { heuristicRoute, llmRoute, type Route } from "../src/agent/router";
import { config } from "../src/config";
import { loadGolden } from "../src/eval/golden";
import { getLLM } from "../src/llm/client";
import { costUsd, PRICES } from "../src/llm/pricing";

/**
 * Router accuracy against the golden set's difficulty labels (easy/hard), for the heuristic router and,
 * with a key, the Haiku router. Misrouting "hard" questions to the small model is the costly error
 * (worse answers); misrouting "easy" ones to the big model only costs money.
 *   npm run eval:router
 */
const golden = loadGolden();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function report(name: string, preds: Route[]) {
  let hh = 0, he = 0, eh = 0, ee = 0;
  golden.forEach((g, i) => {
    if (g.difficulty === "hard") preds[i] === "hard" ? hh++ : he++;
    else preds[i] === "hard" ? eh++ : ee++;
  });
  console.log(`${name}: accuracy ${pct((hh + ee) / golden.length)} (n=${golden.length})`);
  console.log(`   hard questions sent to the small model: ${he}/${hh + he}   easy questions sent to the big model: ${eh}/${ee + eh}`);
  console.log(`   share routed to ${config.routerModel}: ${pct(preds.filter((p) => p === "easy").length / preds.length)}`);
  golden.forEach((g, i) => preds[i] !== g.difficulty && console.log(`     ${g.id} label=${g.difficulty} routed=${preds[i]}: ${g.question}`));
  return { accuracy: (hh + ee) / golden.length, hardToSmall: he, easyToBig: eh };
}

report("heuristic router", golden.map((g) => heuristicRoute(g.question).route));

const llm = (() => { try { const l = getLLM(); return l.provider === "anthropic" ? l : null; } catch { return null; } })();
if (llm) {
  const preds: Route[] = [];
  let cost = 0;
  for (const g of golden) {
    const d = await llmRoute(llm, config.routerModel, g.question);
    preds.push(d.route);
    cost += d.costUsd ?? 0;
  }
  report(`LLM router (${config.routerModel})`, preds);
  console.log(`   router cost for ${golden.length} questions: $${cost.toFixed(5)}`);
} else console.log(`\nLLM router: not run (needs LLM_PROVIDER=anthropic and a key)`);

// Price ratio: why routing matters.
const big = PRICES[config.answerModel], small = PRICES[config.routerModel];
const sample = { input: 6000, output: 500, cacheWrite: 0, cacheRead: 0 };
console.log(`\nFor the same 6k-in / 500-out call: ${config.answerModel} $${costUsd(config.answerModel, sample).toFixed(5)} vs ${config.routerModel} $${costUsd(config.routerModel, sample).toFixed(5)} (${(big.input / small.input).toFixed(0)}x cheaper input).`);
