import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/agent";
import { heuristicRoute } from "../src/agent/router";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { summarise, type EvalRow } from "../src/eval/full";
import { loadGolden } from "../src/eval/golden";
import { ingestDirectory } from "../src/ingest/ingest";
import { costUsd } from "../src/llm/pricing";
import { TraceRecorder } from "../src/trace";
import { FakeLLM, text, toolUse } from "./fakes";
import { freshTestDb } from "./helpers";

describe("routing saves money", () => {
  it("Haiku 5.5 is 20x cheaper than Sonnet 5.5 for the same call", () => {
    const u = { input: 6000, output: 500, cacheWrite: 0, cacheRead: 0 };
    expect(costUsd("claude-sonnet-5-5", u) / costUsd("claude-haiku-5-5", u)).toBeCloseTo(20);
  });
  it("the heuristic router stays at or above its measured 86% on the golden set (regression guard)", () => {
    const golden = loadGolden();
    const acc = golden.filter((g) => heuristicRoute(g.question).route === g.difficulty).length / golden.length;
    expect(acc).toBeGreaterThanOrEqual(0.86);
  });
});

describe("trace timing", () => {
  it("records time to first token once, at the first delta", async () => {
    const rec = new TraceRecorder("agent", "q");
    await new Promise((r) => setTimeout(r, 15));
    rec.markFirstToken();
    await new Promise((r) => setTimeout(r, 15));
    rec.markFirstToken();
    const t = rec.finish({ status: "answered", answer: "", citations: [] });
    expect(t.ttftMs).toBeGreaterThanOrEqual(14);
    expect(t.ttftMs).toBeLessThan(t.latencyMs);
  });

  it("summarise reports p95 latency, TTFT, cost per question, per-route costs, and cache-read share", () => {
    const row = (id: string, route: string, ms: number, cost: number, cacheRead: number): EvalRow => ({
      id, question: id, type: "lookup", difficulty: "easy", route, model: "m", answer: "", refused: false, citedPaths: [], toolCalls: 1,
      latencyMs: ms, ttftMs: ms / 2, costUsd: cost, tokens: { input: 100, output: 10, cacheWrite: 0, cacheRead }, traceId: id,
      det: { pass: true, reasons: [], citedExpected: true },
    });
    const golden = loadGolden().slice(0, 4);
    const rows = [row(golden[0].id, "easy", 100, 0.001, 0), row(golden[1].id, "easy", 200, 0.001, 100), row(golden[2].id, "hard", 900, 0.01, 300), row(golden[3].id, "hard", 1000, 0.01, 0)];
    const s = summarise("t", rows, golden);
    expect(s.latency.p95Ms).toBe(1000);
    expect(s.latency.ttftP95Ms).toBe(500);
    expect(s.cost.perQuestionUsd).toBeCloseTo(0.0055);
    expect(s.byRoute.easy.avgCostUsd).toBeCloseTo(0.001);
    expect(s.tokens.cacheReadShare).toBeCloseTo(400 / 800);
  });
});

describe("agent logs cost and latency per question (Postgres)", async () => {
  const pool = await freshTestDb();
  beforeAll(async () => {
    if (pool) await ingestDirectory(pool, new HashEmbedder(), "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
  });
  afterAll(closePools);

  it.skipIf(!pool)("persists latency, TTFT, tokens, and cost from every model call into the trace row", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "handoff" })], text("Handoff is Mondays at 10:00 [S1].")]);
    const res = await runAgent(pool!, "When is handoff?", { llm, router: "easy" });
    const { rows } = await pool!.query("SELECT latency_ms, ttft_ms, cost_usd::float AS cost, usage FROM traces WHERE id = $1", [res.trace.id]);
    // 2 Haiku calls, each 1000 in / 100 out / 800 cache-read (FakeLLM)
    const expected = 2 * costUsd("claude-haiku-5-5", { input: 1000, output: 100, cacheWrite: 0, cacheRead: 800 });
    expect(rows[0].cost).toBeCloseTo(expected, 6);
    expect(rows[0].usage).toEqual({ input: 2000, output: 200, cacheWrite: 0, cacheRead: 1600 });
    expect(rows[0].ttft_ms).not.toBeNull();
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(rows[0].ttft_ms);
  });
});
