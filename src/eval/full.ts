import type pg from "pg";
import { runAgent, type AgentOptions } from "../agent/agent";
import { config } from "../config";
import type { LLM } from "../llm/client";
import { gradeDeterministic, type DeterministicGrade } from "./grade";
import type { GoldenItem } from "./golden";
import { judge, JUDGE_VERSION } from "./judge";
import { mean, percentile } from "./metrics";

export interface EvalRow {
  id: string;
  question: string;
  type: GoldenItem["type"];
  difficulty: GoldenItem["difficulty"];
  route: string;
  model: string;
  answer: string;
  refused: boolean;
  refusalReason?: string;
  citedPaths: string[];
  toolCalls: number;
  latencyMs: number;
  ttftMs: number | null;
  costUsd: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  traceId: string;
  det: DeterministicGrade;
  judge?: { verdict: "pass" | "fail"; reasoning: string; version: string; costUsd: number };
}

export interface EvalSummary {
  config: string;
  n: number;
  passRate: number;
  passRateDeterministic: number;
  passRateJudge: number | null;
  byType: Record<string, { n: number; pass: number }>;
  byRoute: Record<string, { n: number; pass: number; p95Ms: number; avgCostUsd: number }>;
  refusal: { correctRefusals: number; unanswerable: number; falseRefusals: number; answerable: number };
  citedExpectedRate: number;
  latency: { p50Ms: number; p95Ms: number; ttftP50Ms: number | null; ttftP95Ms: number | null };
  tokens: { avgInput: number; avgOutput: number; cacheReadShare: number };
  cost: { totalUsd: number; perQuestionUsd: number; judgeUsd: number };
}

/** Run the agent on every golden question and grade each answer. Sequential, so latency numbers are clean. */
export async function runFullEval(
  pool: pg.Pool,
  golden: GoldenItem[],
  opts: { agent?: AgentOptions; judgeLLM?: LLM; judgeModel?: string; log?: (s: string) => void } = {},
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const g of golden) {
    const res = await runAgent(pool, g.question, { ...opts.agent });
    const citedPaths = [...new Set(res.citations.map((c) => c.path))];
    const row: EvalRow = {
      id: g.id, question: g.question, type: g.type, difficulty: g.difficulty,
      route: res.route.route, model: res.trace.model ?? "", answer: res.answer, refused: res.refused,
      refusalReason: res.refusalReason, citedPaths,
      toolCalls: res.trace.steps.filter((s) => s.type === "tool").length,
      latencyMs: res.trace.latencyMs, ttftMs: res.trace.ttftMs, costUsd: res.trace.costUsd, tokens: res.trace.usage, traceId: res.trace.id,
      det: gradeDeterministic(g, { answer: res.answer, refused: res.refused, citedPaths }),
    };
    if (opts.judgeLLM) row.judge = await judgeRow(opts.judgeLLM, opts.judgeModel ?? config.answerModel, g, row);
    rows.push(row);
    opts.log?.(`${row.id} ${pass(row) ? "PASS" : "FAIL"} ${row.route.padEnd(4)} ${String(row.latencyMs).padStart(6)} ms  ${row.det.reasons.join("; ")}`);
  }
  return rows;
}

export async function judgeRow(llm: LLM, model: string, g: GoldenItem, row: Pick<EvalRow, "answer">) {
  const v = await judge(llm, model, { question: g.question, reference: g.reference_answer, shouldRefuse: g.should_refuse, answer: row.answer });
  return { verdict: v.verdict, reasoning: v.reasoning, version: JUDGE_VERSION, costUsd: v.costUsd };
}

/**
 * The headline pass/fail for a row. With a judge, both must agree it passed: the judge catches wrong
 * facts that contain the right substrings, and the deterministic check catches missing citations
 * and forbidden (injected) content the judge might wave through.
 */
export function pass(r: EvalRow): boolean {
  return r.judge ? r.judge.verdict === "pass" && r.det.pass : r.det.pass;
}

export function summarise(configKey: string, rows: EvalRow[], golden: GoldenItem[]): EvalSummary {
  const byId = new Map(golden.map((g) => [g.id, g]));
  const tally = <K extends string>(key: (r: EvalRow) => K) => {
    const out: Record<string, EvalRow[]> = {};
    for (const r of rows) (out[key(r)] ??= []).push(r);
    return out;
  };
  const unanswerable = rows.filter((r) => byId.get(r.id)!.should_refuse);
  const answerable = rows.filter((r) => !byId.get(r.id)!.should_refuse);
  const judged = rows.filter((r) => r.judge);
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const ttfts = rows.map((r) => r.ttftMs).filter((x): x is number => x !== null && x !== undefined);
  return {
    config: configKey,
    n: rows.length,
    passRate: rows.filter(pass).length / rows.length,
    passRateDeterministic: rows.filter((r) => r.det.pass).length / rows.length,
    passRateJudge: judged.length ? judged.filter((r) => r.judge!.verdict === "pass").length / judged.length : null,
    byType: Object.fromEntries(Object.entries(tally((r) => r.type)).map(([k, rs]) => [k, { n: rs.length, pass: rs.filter(pass).length }])),
    byRoute: Object.fromEntries(
      Object.entries(tally((r) => r.route)).map(([k, rs]) => [k, {
        n: rs.length, pass: rs.filter(pass).length, p95Ms: percentile(rs.map((r) => r.latencyMs), 95), avgCostUsd: mean(rs.map((r) => r.costUsd)),
      }]),
    ),
    refusal: {
      correctRefusals: unanswerable.filter((r) => r.refused).length,
      unanswerable: unanswerable.length,
      falseRefusals: answerable.filter((r) => r.refused).length,
      answerable: answerable.length,
    },
    citedExpectedRate: mean(answerable.filter((r) => !r.refused).map((r) => (r.det.citedExpected ? 1 : 0))),
    latency: {
      p50Ms: percentile(rows.map((r) => r.latencyMs), 50),
      p95Ms: percentile(rows.map((r) => r.latencyMs), 95),
      ttftP50Ms: ttfts.length ? percentile(ttfts, 50) : null,
      ttftP95Ms: ttfts.length ? percentile(ttfts, 95) : null,
    },
    tokens: {
      avgInput: mean(rows.map((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite)),
      avgOutput: mean(rows.map((r) => r.tokens.output)),
      cacheReadShare: rows.reduce((s, r) => s + r.tokens.cacheRead, 0) / (rows.reduce((s, r) => s + r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite, 0) || 1),
    },
    cost: { totalUsd: total, perQuestionUsd: total / rows.length, judgeUsd: judged.reduce((s, r) => s + r.judge!.costUsd, 0) },
  };
}

export function printSummary(s: EvalSummary): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n== ${s.config} ==`);
  console.log(`pass rate: ${pct(s.passRate)} (${Math.round(s.passRate * s.n)}/${s.n})   deterministic ${pct(s.passRateDeterministic)}   judge ${s.passRateJudge === null ? "not run" : pct(s.passRateJudge)}`);
  console.log(`refusals: ${s.refusal.correctRefusals}/${s.refusal.unanswerable} unanswerable correctly refused; ${s.refusal.falseRefusals}/${s.refusal.answerable} answerable wrongly refused`);
  console.log(`cited an expected doc: ${pct(s.citedExpectedRate)} of non-refused answerable questions`);
  console.log(`time to first token p50 ${s.latency.ttftP50Ms ?? "-"} ms, p95 ${s.latency.ttftP95Ms ?? "-"} ms   tokens/question in ${Math.round(s.tokens.avgInput)} (cache-read share ${pct(s.tokens.cacheReadShare)}), out ${Math.round(s.tokens.avgOutput)}`);
  console.log(`latency p50 ${s.latency.p50Ms} ms, p95 ${s.latency.p95Ms} ms   cost $${s.cost.perQuestionUsd.toFixed(5)}/question (total $${s.cost.totalUsd.toFixed(4)}, judge $${s.cost.judgeUsd.toFixed(4)})`);
  console.log("by type:  " + Object.entries(s.byType).map(([k, v]) => `${k} ${v.pass}/${v.n}`).join(", "));
  console.log("by route: " + Object.entries(s.byRoute).map(([k, v]) => `${k} ${v.pass}/${v.n} (p95 ${v.p95Ms} ms, $${v.avgCostUsd.toFixed(5)}/q)`).join(", "));
}
