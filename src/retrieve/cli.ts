import { closePools, getPool } from "../db/pool";
import { search } from "./search";
import type { SearchMode } from "./types";

// Usage: npm run search -- "when is the on-call handoff?" [--mode vector|fts|hybrid|rerank] [--k 5]
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const mode = (flag("mode") ?? "rerank") as SearchMode;
const k = Number(flag("k") ?? 5);
const question = args.join(" ");
if (!question) {
  console.error('Usage: npm run search -- "your question" [--mode vector|fts|hybrid|rerank] [--k 5]');
  process.exit(1);
}

const { hits, timings } = await search(getPool(), question, { mode, k });
console.log(`mode=${mode}  ${timings.totalMs.toFixed(0)} ms\n`);
for (const [i, h] of hits.entries()) {
  const s = h.signals;
  const why = [
    s.vectorRank && `vec#${s.vectorRank}`,
    s.ftsRank && `fts#${s.ftsRank}`,
    s.rrf !== undefined && `rrf=${s.rrf.toFixed(4)}`,
    s.rerank !== undefined && `rerank=${s.rerank.toFixed(3)}`,
  ].filter(Boolean).join(" ");
  console.log(`${i + 1}. ${h.path}  [${h.headingPath}]  (${why})`);
  console.log(`   ${h.content.replace(/\s+/g, " ").slice(0, 160)}…\n`);
}
await closePools();
