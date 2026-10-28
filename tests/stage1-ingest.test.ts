import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { cosine } from "../src/embed";
import { chunkNote, estimateTokens } from "../src/ingest/chunk";
import { ingestDirectory, listMarkdown } from "../src/ingest/ingest";
import { parseNote } from "../src/ingest/parse";
import { freshTestDb, tempNotes } from "./helpers";

const NOTE = `---
title: On-call policy
tags: [oncall]
updated: 2026-08-25
---
# On-call policy

## Rotation

Weekly rotation. Handoff is Mondays at 10:00 Pacific.

## Escalation

1. Primary has 5 minutes to acknowledge.
2. Then the secondary is paged.

### Night pages

Take the next morning off.

\`\`\`
# not a heading, inside a code fence
\`\`\`
`;

describe("parseNote", () => {
  it("reads title from frontmatter and tracks heading paths", () => {
    const note = parseNote("docs/oncall.md", NOTE);
    expect(note.title).toBe("On-call policy");
    expect(note.frontmatter.updated).toBe("2026-08-25"); // Date objects become strings
    const night = note.blocks.find((b) => b.text.startsWith("Take the next"));
    expect(night?.headings).toEqual(["On-call policy", "Escalation", "Night pages"]);
  });

  it("does not treat # inside code fences as headings", () => {
    const note = parseNote("x.md", NOTE);
    expect(note.blocks.some((b) => b.isHeading && b.text.includes("not a heading"))).toBe(false);
  });

  it("falls back to the first H1, then the filename, for the title", () => {
    expect(parseNote("a.md", "# Hello\n\ntext").title).toBe("Hello");
    expect(parseNote("dir/my-note_file.md", "just text").title).toBe("my note file");
  });
});

describe("chunkNote", () => {
  const opts = { maxTokens: 40, minTokens: 10, overlapTokens: 0 };

  it("never exceeds maxTokens (except an unsplittable single line) and never emits empty chunks", () => {
    const long = parseNote("l.md", `# T\n\n${"word ".repeat(400)}\n\n## B\n\nshort`);
    const chunks = chunkNote(long, opts);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(c.tokenCount).toBeLessThanOrEqual(opts.maxTokens + 5);
    }
  });

  it("labels chunks with the heading path they start in", () => {
    const chunks = chunkNote(parseNote("o.md", NOTE), opts);
    expect(chunks[0].headingPath).toBe("On-call policy");
    expect(chunks.some((c) => c.headingPath === "On-call policy > Escalation")).toBe(true);
  });

  it("merges tiny sections instead of creating one-line chunks", () => {
    const big = chunkNote(parseNote("o.md", NOTE), { maxTokens: 500, minTokens: 400, overlapTokens: 0 });
    expect(big).toHaveLength(1);
  });

  it("adds overlap from the previous chunk when asked", () => {
    const text = parseNote("l.md", `# T\n\n${"alpha beta gamma delta. ".repeat(60)}`);
    const chunks = chunkNote(text, { maxTokens: 60, minTokens: 10, overlapTokens: 10 });
    expect(chunks[1].content.startsWith("…")).toBe(true);
  });

  it("is deterministic", () => {
    const a = chunkNote(parseNote("o.md", NOTE), opts);
    const b = chunkNote(parseNote("o.md", NOTE), opts);
    expect(a).toEqual(b);
  });

  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});

describe("HashEmbedder", () => {
  const e = new HashEmbedder();
  it("returns unit-length 384-d vectors", () => {
    const v = e.embed("on-call rotation handoff");
    expect(v).toHaveLength(384);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });
  it("scores texts that share words above unrelated texts", () => {
    const q = e.embed("when is the on-call handoff?");
    const related = e.embed("Handoff is Mondays at 10:00 for the on-call rotation");
    const unrelated = e.embed("Smart reorder suggests a basket from past orders");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});

describe("ingestDirectory (Postgres)", async () => {
  const pool = await freshTestDb();
  afterAll(closePools);
  const embedder = new HashEmbedder();
  const opts = { maxTokens: 60, minTokens: 10, overlapTokens: 0 };

  it.skipIf(!pool)("ingests, skips unchanged files, updates changed ones, removes deleted ones", async () => {
    const dir = await tempNotes({ "a.md": NOTE, "sub/b.md": "# B\n\nSecond note about Kestrel." });
    expect(await listMarkdown(dir)).toEqual(["a.md", "sub/b.md"]);

    const first = await ingestDirectory(pool!, embedder, dir, opts);
    expect(first).toMatchObject({ added: 2, updated: 0, unchanged: 0, removed: 0 });
    const n1 = (await pool!.query("SELECT count(*)::int AS n FROM chunks")).rows[0].n;
    expect(n1).toBeGreaterThan(2);

    const second = await ingestDirectory(pool!, embedder, dir, opts);
    expect(second).toMatchObject({ added: 0, unchanged: 2 });
    expect((await pool!.query("SELECT count(*)::int AS n FROM chunks")).rows[0].n).toBe(n1);

    await writeFile(path.join(dir, "sub/b.md"), "# B\n\nEdited note about Harbor.");
    await rm(path.join(dir, "a.md"));
    const third = await ingestDirectory(pool!, embedder, dir, opts);
    expect(third).toMatchObject({ updated: 1, removed: 1 });
    const { rows } = await pool!.query("SELECT content FROM chunks");
    expect(rows.map((r) => r.content).join(" ")).toContain("Harbor");
    expect(rows.map((r) => r.content).join(" ")).not.toContain("Handoff");
  });

  it.skipIf(!pool)("re-chunks everything when chunk settings change", async () => {
    const dir = await tempNotes({ "a.md": NOTE });
    await ingestDirectory(pool!, embedder, dir, opts);
    const again = await ingestDirectory(pool!, embedder, dir, { ...opts, maxTokens: 500 });
    expect(again.updated).toBe(1);
  });

  it.skipIf(!pool)("keeps the full-text tsvector in sync automatically", async () => {
    const { rows } = await pool!.query(
      "SELECT count(*)::int AS n FROM chunks WHERE tsv @@ plainto_tsquery('english', 'acknowledge')",
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
