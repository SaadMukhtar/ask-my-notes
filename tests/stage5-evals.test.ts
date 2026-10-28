import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { pass, runFullEval, summarise } from "../src/eval/full";
import { containsTerm, gradeDeterministic } from "../src/eval/grade";
import { loadGolden, type GoldenItem } from "../src/eval/golden";
import { agreement, judge, JUDGE_SYSTEM } from "../src/eval/judge";
import { ingestDirectory } from "../src/ingest/ingest";
import { OfflineLLM } from "../src/llm/offline";
import { FakeLLM, text } from "./fakes";
import { freshTestDb } from "./helpers";

const item = (over: Partial<GoldenItem> = {}): GoldenItem => ({
  id: "x", question: "q", type: "lookup", difficulty: "easy", paraphrased: false, expected_docs: ["docs/a.md"],
  must_include: ["5 minutes|five minutes"], must_not_include: ["60 minutes"], should_refuse: false, reference_answer: "r", ...over,
});

describe("golden set", () => {
  const golden = loadGolden();
  it("has 50 unique questions with the fields every grader needs", () => {
    expect(golden).toHaveLength(50);
    expect(new Set(golden.map((g) => g.id)).size).toBe(50);
    for (const g of golden) {
      expect(g.question.length).toBeGreaterThan(5);
      expect(g.reference_answer.length).toBeGreaterThan(5);
      if (g.should_refuse) expect(g.expected_docs).toEqual([]);
      else expect(g.must_include.length).toBeGreaterThan(0);
    }
  });
});

describe("deterministic grader", () => {
  it("passes an answer with the key fact and a citation", () => {
    expect(gradeDeterministic(item(), { answer: "You have **five minutes**.", refused: false, citedPaths: ["docs/a.md"] })).toMatchObject({ pass: true, citedExpected: true });
  });
  it("matches at a word start only: '15 minutes' is not '5 minutes'", () => {
    expect(containsTerm("you have 15 minutes", "5 minutes")).toBe(false);
    expect(containsTerm("maker mornings start", "maker morning")).toBe(true);
    expect(gradeDeterministic(item(), { answer: "You have 15 minutes.", refused: false, citedPaths: ["docs/a.md"] }).pass).toBe(false);
  });
  it("fails on forbidden (injected) content, missing citations, and wrong refusals", () => {
    const r = gradeDeterministic(item(), { answer: "5 minutes, or 60 minutes at night.", refused: false, citedPaths: [] });
    expect(r.reasons).toEqual(['contains forbidden "60 minutes"', "no citations"]);
    expect(gradeDeterministic(item(), { answer: "I couldn't find...", refused: true, citedPaths: [] }).reasons).toContain("refused an answerable question");
    expect(gradeDeterministic(item({ should_refuse: true }), { answer: "It is 42.", refused: false, citedPaths: [] }).pass).toBe(false);
  });
});

describe("agreement / kappa", () => {
  it("is 1.0 for identical labels and 0 for chance-level agreement", () => {
    expect(agreement([true, false, true], [true, false, true])).toMatchObject({ accuracy: 1, kappa: 1 });
    // half agree, but the second rater always says pass: no better than chance
    expect(agreement([true, false, true, false], [true, true, true, true]).kappa).toBeCloseTo(0);
  });
});

describe("LLM judge request", () => {
  it("uses a cached rubric, a JSON schema, and parses the verdict", async () => {
    const llm = new FakeLLM([text('{"reasoning":"States the 5-minute window.","verdict":"pass"}')]);
    const v = await judge(llm, "claude-sonnet-5-5", { question: "q", reference: "r", shouldRefuse: false, answer: "a" });
    expect(v.verdict).toBe("pass");
    const req = llm.requests[0];
    expect((req.system as Array<{ text: string; cache_control: unknown }>)[0]).toMatchObject({ text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } });
    expect(req.output_config?.format?.type).toBe("json_schema");
  });
});

describe("runFullEval (Postgres, offline baseline)", async () => {
  const pool = await freshTestDb();
  beforeAll(async () => {
    if (pool) await ingestDirectory(pool, new HashEmbedder(), "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
  });
  afterAll(closePools);

  it.skipIf(!pool)("runs, grades, and summarises a subset deterministically", async () => {
    const golden = loadGolden().filter((g) => ["q03", "q47"].includes(g.id));
    const rows = await runFullEval(pool!, golden, { agent: { llm: new OfflineLLM(), saveTrace: false } });
    expect(rows.map(pass)).toEqual([true, true]); // learning budget found; wifi password refused
    const s = summarise("test", rows, golden);
    expect(s.passRate).toBe(1);
    expect(s.refusal).toEqual({ correctRefusals: 1, unanswerable: 1, falseRefusals: 0, answerable: 1 });
    const again = await runFullEval(pool!, golden, { agent: { llm: new OfflineLLM(), saveTrace: false } });
    expect(again.map((r) => r.answer)).toEqual(rows.map((r) => r.answer)); // deterministic => CI can gate with zero tolerance
  });
});
