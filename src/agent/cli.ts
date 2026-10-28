import { closePools, getPool } from "../db/pool";
import { runAgent } from "./agent";

// Usage: npm run agent -- "Why did the Harbor cutover slip?"
const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('Usage: npm run agent -- "your question"');
  process.exit(1);
}
const res = await runAgent(getPool(), question, {
  onEvent: (e) => {
    if (e.type === "text") process.stdout.write(e.delta);
    else if (e.type === "route") console.log(`→ route: ${e.route} (${e.reason}) → ${e.model}`);
    else if (e.type === "tool_start") console.log(`→ ${e.name}(${JSON.stringify(e.input).slice(0, 120)})`);
    else if (e.type === "verify") console.log(`\n→ verify: ${e.ok ? "ok" : `FAILED: ${e.problems.join("; ")}`}`);
    else if (e.type === "retry") console.log("→ retrying once");
  },
});
console.log(`\n\n${res.refused ? `REFUSED (${res.refusalReason})` : "ANSWER"}:\n${res.answer}\n`);
for (const c of res.citations) console.log(`  [${c.id}] ${c.path} > ${c.headingPath}`);
for (const d of res.drafts) console.log(`  draft saved: ${d.path}`);
const t = res.trace;
const tools = t.steps.filter((s) => s.type === "tool").length;
console.log(`\n${t.model} · ${tools} tool calls · ${t.latencyMs} ms · $${t.costUsd.toFixed(5)} · trace ${t.id}`);
await closePools();
