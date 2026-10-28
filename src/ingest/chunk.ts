import type { ParsedNote } from "./parse";

export interface Chunk {
  index: number;
  /** "Doc title > Section > Subsection" for the first section in the chunk. */
  headingPath: string;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
}

/**
 * Rough token estimate: ~4 characters per token for English. Good enough for sizing chunks;
 * we never use it for billing (the API reports real token counts).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Pack a note's blocks into chunks of at most `maxTokens`.
 *
 * Rules, in order of importance:
 * 1. Never split a paragraph/list/table unless it alone is bigger than maxTokens.
 * 2. Prefer to start a new chunk at a top-level section boundary (## heading), but only once the
 *    current chunk has at least `minTokens`. That merges tiny sections instead of making
 *    one-line chunks that have too little context to be useful.
 * 3. Carry the last ~overlapTokens of text into the next chunk so a fact that straddles the
 *    boundary is still findable from either side.
 */
export function chunkNote(note: ParsedNote, opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let tokens = 0;
  let headingPath = note.title;
  let overlap = "";

  const pathFor = (headings: string[]) => {
    // Drop the H1 if it just repeats the title.
    const hs = headings.filter((h, i) => !(i === 0 && h === note.title));
    return [note.title, ...hs].join(" > ");
  };

  const emit = () => {
    const body = parts.join("\n\n").trim();
    if (!body || parts.every((p) => p.startsWith("#"))) return; // headings with no text are not worth a chunk
    const content = overlap ? `${overlap}\n\n${body}` : body;
    chunks.push({ index: chunks.length, headingPath, content, tokenCount: estimateTokens(content) });
    overlap = opts.overlapTokens > 0 ? tail(body, opts.overlapTokens) : "";
    parts = [];
    tokens = 0;
  };

  for (const block of note.blocks) {
    const isSectionStart = block.isHeading && block.depth <= 2;
    if (isSectionStart && tokens >= opts.minTokens) emit();

    for (const piece of splitOversized(block.text, opts.maxTokens)) {
      const t = estimateTokens(piece);
      if (tokens + t > opts.maxTokens && tokens > 0) emit();
      if (parts.length === 0) headingPath = pathFor(block.headings);
      parts.push(piece);
      tokens += t;
    }
  }
  emit();
  return chunks;
}

/** Split a single block that is larger than maxTokens: by lines, then sentences, then words. */
function splitOversized(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const sep = text.includes("\n") ? "\n" : " ";
  let units = sep === "\n" ? text.split("\n") : text.split(/(?<=[.!?])\s+/);
  if (units.length === 1) units = text.split(/\s+/);
  units = units.flatMap((u) => (sep === "\n" ? splitOversized(u, maxTokens) : [u]));
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    const next = cur ? `${cur}${sep}${u}` : u;
    if (estimateTokens(next) > maxTokens && cur) {
      out.push(cur);
      cur = u;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/** Last ~n tokens of text, cut at a word boundary, prefixed with an ellipsis so it reads as context. */
function tail(text: string, n: number): string {
  const chars = n * 4;
  if (text.length <= chars) return "";
  // Only carry over plain text; a half table or half list confuses more than it helps.
  const slice = text.slice(-chars);
  const cut = slice.indexOf(" ");
  const t = slice.slice(cut + 1).trim();
  return t.startsWith("|") ? "" : `…${t}`;
}
