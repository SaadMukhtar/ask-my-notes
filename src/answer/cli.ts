import { closePools, getPool } from "../db/pool";
import { answerQuestion } from "./answer";

// Usage: npm run ask -- "When is the on-call handoff?"
const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}
const res = await answerQuestion(getPool(), question, { onText: (t) => process.stdout.write(t) });
console.log("\n\nSources:");
for (const c of res.citations) console.log(`  [${c.id}] ${c.path} > ${c.headingPath}`);
const u = res.trace.usage;
console.log(
  `\n${res.refused ? "REFUSED" : "answered"} · ${res.trace.model} · ${res.trace.latencyMs} ms · $${res.trace.costUsd.toFixed(5)} · ` +
    `tokens in=${u.input} out=${u.output} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} · trace ${res.trace.id}`,
);
await closePools();
