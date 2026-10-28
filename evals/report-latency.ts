import { closePools, getPool } from "../src/db/pool";
import { mean, percentile } from "../src/eval/metrics";
import type { TraceStep } from "../src/trace";

/**
 * Latency and cost report built from logged traces (every real request and every eval run is traced).
 *   npm run report:latency                    # agent traces from the last 24 h
 *   npm run report:latency -- --hours 1 --kind answer
 * Groups by route and model, and breaks latency down by step type so you can see where time goes.
 */
const args = process.argv.slice(2);
const flag = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const hours = Number(flag("hours", "24"));
const kind = flag("kind", "agent");

const { rows } = await getPool().query(
  `SELECT route, model, status, latency_ms, ttft_ms, cost_usd::float AS cost, usage, steps
     FROM traces WHERE kind = $1 AND created_at > now() - make_interval(hours => $2) ORDER BY created_at`,
  [kind, hours],
);
if (!rows.length) {
  console.log(`No ${kind} traces in the last ${hours} h. Run some questions or an eval first.`);
  process.exit(0);
}

const groups = new Map<string, typeof rows>();
for (const r of rows) {
  const k = `${r.route ?? "-"} / ${r.model}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}

console.log(`${rows.length} ${kind} traces from the last ${hours} h\n`);
console.log("route / model".padEnd(34) + "   n   p50 ms   p95 ms  p95 TTFT   $/question  p95 $     in tok  out tok  cache-read  refused");
const line = (name: string, rs: typeof rows) => {
  const lat = rs.map((r) => r.latency_ms);
  const ttft = rs.map((r) => r.ttft_ms).filter((x) => x !== null);
  const cost = rs.map((r) => r.cost);
  const inTok = rs.map((r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite);
  const cacheShare = rs.reduce((s, r) => s + r.usage.cacheRead, 0) / (inTok.reduce((a, b) => a + b, 0) || 1);
  console.log(
    name.padEnd(34) +
      String(rs.length).padStart(4) +
      String(percentile(lat, 50)).padStart(9) +
      String(percentile(lat, 95)).padStart(9) +
      String(ttft.length ? percentile(ttft, 95) : "-").padStart(10) +
      `  $${mean(cost).toFixed(5)}`.padStart(13) +
      `  $${percentile(cost, 95).toFixed(5)}`.padStart(10) +
      String(Math.round(mean(inTok))).padStart(10) +
      String(Math.round(mean(rs.map((r) => r.usage.output)))).padStart(9) +
      `${(cacheShare * 100).toFixed(0)}%`.padStart(12) +
      `${rs.filter((r) => r.status === "refused").length}`.padStart(9),
  );
};
for (const [k, rs] of groups) line(k, rs);
line("ALL", rows);

// Where does the time go? Average ms per question spent in each step type.
const byType = new Map<string, number[]>();
for (const r of rows) {
  const per = new Map<string, number>();
  for (const s of r.steps as TraceStep[]) per.set(s.type, (per.get(s.type) ?? 0) + s.ms);
  for (const [t, ms] of per) byType.set(t, [...(byType.get(t) ?? []), ms]);
}
console.log("\nTime per question by step type (mean / p95 ms):");
for (const [t, ms] of byType) console.log(`  ${t.padEnd(8)} ${mean(ms).toFixed(1).padStart(8)} / ${percentile(ms, 95).toFixed(1)}`);
await closePools();
