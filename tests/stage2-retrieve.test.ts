import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { mean, percentile, recallAtK, reciprocalRank } from "../src/eval/metrics";
import { ingestDirectory } from "../src/ingest/ingest";
import { toOrQuery } from "../src/retrieve/fulltext";
import { reciprocalRankFusion } from "../src/retrieve/hybrid";
import { HeuristicReranker } from "../src/retrieve/rerank";
import { search } from "../src/retrieve/search";
import type { Hit } from "../src/retrieve/types";
import { freshTestDb } from "./helpers";

const hit = (id: number, path = `d${id}.md`, content = "", headingPath = "T"): Hit => ({
  chunkId: id, path, title: "T", headingPath, content, score: 0, signals: {},
});

describe("toOrQuery", () => {
  it("drops stopwords and ORs the rest", () => {
    expect(toOrQuery("When is the on-call handoff?")).toBe("call | handoff");
  });
  it("strips tsquery syntax so user input cannot break the query", () => {
    expect(toOrQuery("foo & bar | !baz:* ('x')")).toBe("foo | bar | baz");
    expect(toOrQuery("the a of")).toBeNull();
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards items that appear high in both lists", () => {
    const fused = reciprocalRankFusion([
      [hit(1), hit(2), hit(3)],
      [hit(3), hit(2), hit(4)],
    ]);
    // 2 and 3 appear in both lists; 3 has ranks (3,1), 2 has ranks (2,2): 1/63+1/61 > 1/62+1/62
    expect(fused.map((h) => h.chunkId).slice(0, 2)).toEqual([3, 2]);
    expect(fused[0].score).toBeCloseTo(1 / 63 + 1 / 61, 10);
  });
  it("does not mutate the input hits", () => {
    const a = hit(1);
    reciprocalRankFusion([[a], [a]]);
    expect(a.score).toBe(0);
  });
});

describe("HeuristicReranker", () => {
  it("prefers the chunk that covers the rare query terms and exact identifiers", async () => {
    const r = new HeuristicReranker();
    const out = await r.rerank("what caused INC-2041?", [
      { ...hit(1, "a.md", "General notes about incidents and outages."), signals: { rrf: 0.03 } },
      { ...hit(2, "b.md", "INC-2041 was caused by PgBouncer max_client_conn."), signals: { rrf: 0.02 } },
    ]);
    expect(out[0].chunkId).toBe(2);
  });
});

describe("metrics", () => {
  it("recall@k treats a|b as either-or and counts each slot once", () => {
    expect(recallAtK(["a.md|b.md", "c.md"], ["b.md", "x.md", "c.md"], 2)).toBe(0.5);
    expect(recallAtK(["a.md|b.md", "c.md"], ["b.md", "x.md", "c.md"], 3)).toBe(1);
    expect(Number.isNaN(recallAtK([], ["a.md"], 3))).toBe(true);
  });
  it("reciprocal rank is 1/position of the first relevant doc", () => {
    expect(reciprocalRank(["c.md"], ["a.md", "b.md", "c.md"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["z.md"], ["a.md"])).toBe(0);
  });
  it("percentile uses nearest rank; mean ignores NaN", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 50)).toBe(50);
    expect(mean([1, NaN, 3])).toBe(2);
  });
});

describe("search over the sample corpus (Postgres)", async () => {
  const pool = await freshTestDb();
  const embedder = new HashEmbedder();
  beforeAll(async () => {
    if (pool) await ingestDirectory(pool, embedder, "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
  });
  afterAll(closePools);

  for (const mode of ["vector", "fts", "hybrid", "rerank"] as const) {
    it.skipIf(!pool)(`${mode}: finds the on-call policy for an on-call question`, async () => {
      const { hits } = await search(pool!, "how long does the primary on-call have to acknowledge a page", {
        mode, k: 3, embedder, reranker: new HeuristicReranker(),
      });
      expect(hits.map((h) => h.path)).toContain("docs/oncall-policy.md");
      expect(hits).toHaveLength(3);
    });
  }

  it.skipIf(!pool)("hybrid keeps signals from both retrievers", async () => {
    const { hits } = await search(pool!, "PgBouncer max_client_conn", { mode: "hybrid", k: 5, embedder });
    const both = hits.find((h) => h.signals.vectorRank && h.signals.ftsRank);
    expect(both).toBeDefined();
    expect(both!.signals.rrf).toBeGreaterThan(0);
  });
});
