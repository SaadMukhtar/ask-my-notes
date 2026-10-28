import matter from "gray-matter";
import path from "node:path";

export interface Block {
  /** Headings above this block, outermost first, e.g. ["On-call policy", "Escalation"]. */
  headings: string[];
  /** Heading depth of the section this block belongs to (1 = "#", 2 = "##"...; 0 = before any heading). */
  depth: number;
  /** True if this block is the heading line itself (we keep headings in chunk text for context). */
  isHeading: boolean;
  text: string;
}

export interface ParsedNote {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  blocks: Block[];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Turn one markdown file into a title, its frontmatter, and a flat list of "blocks"
 * (paragraphs, lists, tables, code fences) each tagged with the headings above it.
 * We do our own light parsing instead of a full markdown AST: notes are simple, and keeping
 * the original markdown text (tables, lists) is what we want to show the model anyway.
 */
export function parseNote(relPath: string, raw: string): ParsedNote {
  const { data, content } = matter(raw);
  const lines = content.split(/\r?\n/);
  const blocks: Block[] = [];
  const stack: { depth: number; text: string }[] = [];
  let firstH1: string | undefined;
  let buf: string[] = [];
  let inFence = false;

  const currentHeadings = () => stack.map((h) => h.text);
  const currentDepth = () => (stack.length ? stack[stack.length - 1].depth : 0);
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) blocks.push({ headings: currentHeadings(), depth: currentDepth(), isHeading: false, text });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? HEADING.exec(line) : null;
    if (m) {
      flush();
      const depth = m[1].length;
      const text = m[2];
      if (depth === 1 && !firstH1) firstH1 = text;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ depth, text });
      blocks.push({ headings: currentHeadings(), depth, isHeading: true, text: line.trim() });
      continue;
    }
    // A blank line ends a paragraph, but not inside a code fence.
    if (!inFence && line.trim() === "") flush();
    else buf.push(line);
  }
  flush();

  const title =
    (typeof data.title === "string" && data.title.trim()) ||
    firstH1 ||
    path.basename(relPath, path.extname(relPath)).replace(/[-_]+/g, " ");

  return { path: relPath, title, frontmatter: normaliseFrontmatter(data), blocks };
}

// gray-matter turns YAML dates into Date objects; JSONB wants plain strings.
// (JSON.stringify's replacer is too late: Date.toJSON has already run by then.)
function normaliseFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const fix = (v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString().slice(0, 10)
      : Array.isArray(v)
        ? v.map(fix)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
          : v;
  return fix(data) as Record<string, unknown>;
}
