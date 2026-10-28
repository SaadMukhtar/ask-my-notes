import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/agent";
import { AGENT_SYSTEM_PROMPT } from "../src/agent/prompt";
import { heuristicRoute, llmRoute } from "../src/agent/router";
import { withTimeout } from "../src/agent/tools";
import { REFUSAL } from "../src/answer/prompt";
import { structuralVerifier } from "../src/guardrails/structural";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { ingestDirectory } from "../src/ingest/ingest";
import { OfflineLLM } from "../src/llm/offline";
import { FakeLLM, text, toolUse } from "./fakes";
import { freshTestDb } from "./helpers";

describe("router", () => {
  it.each([
    ["When is the on-call handoff?", "easy"],
    ["What is the current max_client_conn setting in PgBouncer?", "easy"],
    ["Why did we choose Unleash over LaunchDarkly?", "hard"],
    ["Summarize the Sprint 18 retrospective.", "hard"],
    ["Draft an onboarding checklist page.", "hard"],
  ])("heuristic: %s -> %s", (q, route) => {
    expect(heuristicRoute(q).route).toBe(route);
  });

  it("LLM router parses EASY/HARD and falls back to the heuristic on garbage", async () => {
    expect((await llmRoute(new FakeLLM([text("EASY")]), "claude-haiku-5-5", "Why X?")).route).toBe("easy");
    const fallback = await llmRoute(new FakeLLM([text("banana")]), "claude-haiku-5-5", "Why X?");
    expect(fallback).toMatchObject({ route: "hard", by: "heuristic" });
    const failing = await llmRoute(new FakeLLM([]), "claude-haiku-5-5", "When is handoff?");
    expect(failing).toMatchObject({ route: "easy", by: "heuristic" });
  });

  it("LLM router sends thinking disabled and a tiny max_tokens (cheap and fast)", async () => {
    const llm = new FakeLLM([text("HARD")]);
    await llmRoute(llm, "claude-haiku-5-5", "q");
    expect(llm.requests[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16, thinking: { type: "disabled" } });
  });
});

describe("withTimeout", () => {
  it("rejects slow work and passes fast work through", async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 10, "slow")).rejects.toThrow("slow timed out after 10 ms");
    await expect(withTimeout(Promise.resolve(42), 100, "fast")).resolves.toBe(42);
  });
});

describe("runAgent (Postgres + fake model)", async () => {
  const pool = await freshTestDb();
  beforeAll(async () => {
    if (pool) await ingestDirectory(pool, new HashEmbedder(), "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
  });
  afterAll(closePools);
  // Pin the structural verifier: these tests are about the loop, stage 6 tests cover verification.
  const base = { router: "hard" as const, saveTrace: false, verifier: structuralVerifier };

  it.skipIf(!pool)("search -> answer: routes, calls tools, caches, cites, and traces every step", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "on-call handoff" })], text("Handoff is Mondays at 10:00 Pacific [S1].")]);
    const res = await runAgent(pool!, "When is the on-call handoff?", { ...base, llm });
    expect(res.refused).toBe(false);
    expect(res.citations[0].path).toBe("docs/oncall-policy.md");

    const [first, second] = llm.requests;
    expect(first.model).toBe("claude-sonnet-5-5"); // hard route -> big model
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.system).toBe(AGENT_SYSTEM_PROMPT);
    expect(first.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual(["search", "read_page", "draft_page"]);
    const toolResult = (second.messages[2].content as Anthropic.ToolResultBlockParam[])[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(String(toolResult.content)).toContain('<source id="S1" path="docs/oncall-policy.md"');

    expect(res.trace.steps.map((s) => s.type)).toEqual(["route", "llm", "tool", "llm", "verify"]);
    expect(res.trace.usage.input).toBe(2000);
  });

  it.skipIf(!pool)("easy route uses the small model", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "handoff" })], text("Mondays at 10:00 [S1].")]);
    await runAgent(pool!, "When is handoff?", { ...base, router: "easy", llm });
    expect(llm.requests[0].model).toBe("claude-haiku-5-5");
  });

  it.skipIf(!pool)("returns parallel tool results in one user message", async () => {
    const llm = new FakeLLM([
      [toolUse("a", "search", { query: "harbor" }), toolUse("b", "read_page", { path: "projects/harbor-overview.md" })],
      text("Harbor moved to Postgres 16 [S1]."),
    ]);
    await runAgent(pool!, "q", { ...base, llm });
    const results = llm.requests[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  it.skipIf(!pool)("hard stop: refuses after the max number of tool steps", async () => {
    const llm = new FakeLLM(Array.from({ length: 10 }, (_, i) => [toolUse(`t${i}`, "search", { query: `try ${i}` })]));
    const res = await runAgent(pool!, "q", { ...base, llm, maxToolSteps: 6 });
    expect(res).toMatchObject({ refused: true, refusalReason: "max_steps" });
    expect(res.trace.steps.filter((s) => s.type === "tool")).toHaveLength(6);
    expect(res.answer.startsWith(REFUSAL)).toBe(true);
  });

  it.skipIf(!pool)("hard stop: refuses when the token budget is spent", async () => {
    // FakeLLM reports 1,900 tokens per call
    const llm = new FakeLLM(Array.from({ length: 5 }, (_, i) => [toolUse(`t${i}`, "search", { query: "x" })]));
    const res = await runAgent(pool!, "q", { ...base, llm, tokenBudget: 3000 });
    expect(res.refusalReason).toBe("token_budget");
    expect(llm.requests).toHaveLength(2);
  });

  it.skipIf(!pool)("tool errors go back to the model as is_error results, and the loop recovers", async () => {
    const llm = new FakeLLM([
      [toolUse("t1", "read_page", { path: "nope/missing.md" })],
      [toolUse("t2", "teleport", {})],
      [toolUse("t3", "search", { query: "handoff" })],
      text("Handoff is Mondays [S1]."),
    ]);
    const res = await runAgent(pool!, "q", { ...base, llm });
    const r1 = (llm.requests[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0];
    const r2 = (llm.requests[2].messages[4].content as Anthropic.ToolResultBlockParam[])[0];
    expect(r1).toMatchObject({ is_error: true });
    expect(String(r1.content)).toContain('No note at "nope/missing.md"');
    expect(String(r2.content)).toContain('Unknown tool "teleport"');
    expect(res.refused).toBe(false);
  });

  it.skipIf(!pool)("bad citation -> one retry with tools disabled -> success", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "handoff" })], text("Handoff is on Mondays at 10:00 [S42]."), text("Handoff is on Mondays at 10:00 [S1].")]);
    const events: string[] = [];
    const res = await runAgent(pool!, "q", { ...base, llm, onEvent: (e) => events.push(e.type) });
    expect(res.refused).toBe(false);
    expect(llm.requests[2].tool_choice).toEqual({ type: "none" });
    expect(events).toContain("retry");
  });

  it.skipIf(!pool)("bad citation twice -> refuse", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "handoff" })], text("Handoff is on Mondays at 10:00 [S42]."), text("Still wrong, it is Mondays [S43].")]);
    const res = await runAgent(pool!, "q", { ...base, llm });
    expect(res).toMatchObject({ refused: true, refusalReason: "verification_failed" });
  });

  it.skipIf(!pool)("model's own refusal sentence is passed through as a refusal", async () => {
    const llm = new FakeLLM([[toolUse("t1", "search", { query: "wifi password" })], text(REFUSAL)]);
    const res = await runAgent(pool!, "What is the Wi-Fi password?", { ...base, llm });
    expect(res).toMatchObject({ refused: true, refusalReason: "no_evidence" });
  });

  it.skipIf(!pool)("offline baseline: drafts a page into the drafts dir when asked to write", async () => {
    const draftsDir = await mkdtemp(path.join(tmpdir(), "drafts-"));
    const res = await runAgent(pool!, "Draft a short page summarizing Project Harbor for the engineering all-hands.", { llm: new OfflineLLM(), draftsDir, saveTrace: false });
    expect(res.drafts).toHaveLength(1);
    expect(await readFile(res.drafts[0].path, "utf8")).toContain("status: draft");
    expect(res.trace.steps.filter((s) => s.type === "tool").map((s) => s.name)).toEqual(["search", "read_page", "draft_page"]);
  });
});
