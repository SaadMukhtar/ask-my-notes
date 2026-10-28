import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { z } from "zod";
import { search } from "../retrieve/search";
import type { Hit } from "../retrieve/types";
import type { SourceRegistry } from "./sources";

/**
 * Tool definitions, as Claude sees them. Descriptions matter: they are the only documentation the
 * model gets, so they say *when* to use each tool, not just what it does.
 * `strict: true` makes the API guarantee the arguments match the schema.
 */
export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search the user's notes with hybrid keyword + semantic search. Returns up to 5 relevant passages as <source> blocks with ids you can cite. " +
      "Use it first for any question. Use specific terms (names, ids, dates). If results miss the point, search again with different words.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, in plain words." } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "read_page",
    description:
      "Read a whole note by its path (shown in the path attribute of each <source>). Use it when a passage looks relevant but is cut off, " +
      "or when you need to summarize or draft from a full page. Returns every section of the page as <source> blocks.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Note path, e.g. projects/harbor-overview.md" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "draft_page",
    description:
      "Save a new markdown page draft for the user to review. Only use this when the user explicitly asks you to write, draft, or create a page or document. " +
      "The body must be markdown and must cite sources with [S#] markers for every fact. Drafts are saved for review, never added to the notes automatically.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title." },
        body: { type: "string", description: "Full markdown body, with [S#] citations." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Runtime validation, even with strict tools: the fake/offline models and future changes should
// fail loudly here rather than deep inside a tool.
const schemas = {
  search: z.object({ query: z.string().min(1).max(500) }),
  read_page: z.object({ path: z.string().min(1).max(300) }),
  draft_page: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(20_000) }),
};

export interface ToolContext {
  pool: pg.Pool;
  registry: SourceRegistry;
  draftsDir: string;
  drafts: { path: string; title: string; body: string }[];
}

export interface ToolOutput {
  content: string;
  /** Machine-readable summary for the trace (paths/chunk ids), so evals can replay without re-running. */
  summary: unknown;
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
  switch (name) {
    case "search": {
      const { query } = schemas.search.parse(rawInput);
      const { hits } = await search(ctx.pool, query, { k: 5 });
      if (!hits.length) return { content: "No matching passages.", summary: { hits: [] } };
      return {
        content: hits.map((h) => ctx.registry.render(h)).join("\n\n"),
        summary: { hits: hits.map((h) => ({ id: ctx.registry.register(h), path: h.path, chunkId: h.chunkId })) },
      };
    }
    case "read_page": {
      const { path: p } = schemas.read_page.parse(rawInput);
      const hits = await readPage(ctx.pool, p);
      if (!hits.length) {
        const { rows } = await ctx.pool.query("SELECT path FROM documents WHERE path ILIKE $1 LIMIT 5", [`%${path.basename(p, ".md")}%`]);
        throw new Error(`No note at "${p}".${rows.length ? ` Did you mean: ${rows.map((r) => r.path).join(", ")}?` : ""}`);
      }
      return {
        content: hits.map((h) => ctx.registry.render(h)).join("\n\n"),
        summary: { path: p, chunks: hits.map((h) => ({ id: ctx.registry.register(h), chunkId: h.chunkId })) },
      };
    }
    case "draft_page": {
      const { title, body } = schemas.draft_page.parse(rawInput);
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "draft";
      await mkdir(ctx.draftsDir, { recursive: true });
      const file = path.join(ctx.draftsDir, `${slug}.md`);
      await writeFile(file, `---\ntitle: ${JSON.stringify(title)}\nstatus: draft\n---\n# ${title}\n\n${body}\n`);
      ctx.drafts.push({ path: file, title, body });
      return { content: `Draft saved to ${file}. Tell the user it is a draft for review and summarize what it covers.`, summary: { file, title, chars: body.length } };
    }
    default:
      throw new Error(`Unknown tool "${name}". Available: search, read_page, draft_page.`);
  }
}

async function readPage(pool: pg.Pool, p: string): Promise<Hit[]> {
  const { rows } = await pool.query(
    `SELECT c.id, d.path, d.title, c.heading_path, c.content
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.path = $1 ORDER BY c.chunk_index`,
    [p],
  );
  return rows.map((r) => ({ chunkId: r.id, path: r.path, title: r.title, headingPath: r.heading_path, content: r.content, score: 0, signals: {} }));
}

/** Reject after `ms`. The tool keeps running in the background, but the agent moves on. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}
