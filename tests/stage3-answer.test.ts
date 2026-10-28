import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerQuestion } from "../src/answer/answer";
import { citedIds, splitClaims } from "../src/answer/citations";
import { REFUSAL, SYSTEM_PROMPT } from "../src/answer/prompt";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { ingestDirectory } from "../src/ingest/ingest";
import { OfflineLLM, parseSources } from "../src/llm/offline";
import { costUsd } from "../src/llm/pricing";
import { FakeLLM, text } from "./fakes";
import { freshTestDb } from "./helpers";

describe("citations", () => {
  it("finds distinct cited ids in order", () => {
    expect(citedIds("A [S2]. B [S1][S2]. C [S3].")).toEqual(["S2", "S1", "S3"]);
  });
  it("splits answers into claims and keeps trailing citations with their sentence", () => {
    const claims = splitClaims("You have 5 minutes to acknowledge [S1]. Then the secondary is paged. [S2]\n- Handoff is Monday [S3].");
    expect(claims.map((c) => c.sourceIds)).toEqual([["S1"], ["S2"], ["S3"]]);
    expect(claims[0].claim).toBe("You have 5 minutes to acknowledge.");
  });
});

describe("pricing", () => {
  it("prices cache reads far below fresh input", () => {
    const fresh = costUsd("claude-sonnet-5-5", { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 });
    const cached = costUsd("claude-sonnet-5-5", { input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 });
    expect(fresh).toBe(2);
    expect(cached).toBeCloseTo(0.2);
  });
  it("throws for unknown models instead of silently reporting $0", () => {
    expect(() => costUsd("gpt-whatever", { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 })).toThrow();
  });
});

describe("answerQuestion (Postgres + fake model)", async () => {
  const pool = await freshTestDb();
  beforeAll(async () => {
    if (pool) await ingestDirectory(pool, new HashEmbedder(), "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
  });
  afterAll(closePools);

  it.skipIf(!pool)("sends sources + a cached, stable system prompt, streams text, and resolves citations", async () => {
    const llm = new FakeLLM([text("Handoff is Mondays at 10:00 Pacific [S1].")]);
    const deltas: string[] = [];
    const res = await answerQuestion(pool!, "When is the on-call handoff?", { llm, onText: (d) => deltas.push(d) });

    const req = llm.requests[0];
    const system = req.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].text).toBe(SYSTEM_PROMPT); // byte-identical every time => cacheable
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    const user = req.messages[0].content as string;
    expect(user).toContain('<source id="S1"');
    expect(user.trim().endsWith("Question: When is the on-call handoff?")).toBe(true);

    expect(deltas.join("")).toBe("Handoff is Mondays at 10:00 Pacific [S1].");
    expect(res.refused).toBe(false);
    expect(res.citations[0].id).toBe("S1");
    expect(res.citations[0].path).toBe(parseSources(user)[0].path);
    expect(res.trace.usage.cacheRead).toBe(800);
    expect(res.trace.costUsd).toBeGreaterThan(0);
  });

  it.skipIf(!pool)("detects the refusal sentence and drops citations that point at no source", async () => {
    const res = await answerQuestion(pool!, "What is the Wi-Fi password?", { llm: new FakeLLM([text(REFUSAL)]) });
    expect(res.refused).toBe(true);
    const res2 = await answerQuestion(pool!, "When is handoff?", { llm: new FakeLLM([text("Mondays [S99].")]) });
    expect(res2.citations).toEqual([]);
  });

  it.skipIf(!pool)("logs a trace row with steps", async () => {
    const res = await answerQuestion(pool!, "When is handoff?", { llm: new FakeLLM([text("Mondays [S1].")]) });
    const { rows } = await pool!.query("SELECT kind, status, jsonb_array_length(steps) AS n FROM traces WHERE id = $1", [res.trace.id]);
    expect(rows[0]).toEqual({ kind: "answer", status: "answered", n: 2 });
  });

  it.skipIf(!pool)("offline baseline answers with citations, and refuses when nothing matches", async () => {
    const llm = new OfflineLLM();
    const ok = await answerQuestion(pool!, "What is the yearly learning budget per engineer?", { llm });
    expect(ok.answer).toContain("1,200");
    expect(ok.citations.length).toBeGreaterThan(0);
    const no = await answerQuestion(pool!, "What is the Wi-Fi password for the Portland office?", { llm });
    expect(no.refused).toBe(true);
  });
});
