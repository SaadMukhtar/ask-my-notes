import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { config } from "../config";
import { toPgVector } from "../db/pool";
import type { Embedder } from "../embed/types";
import { chunkNote, type ChunkOptions } from "./chunk";
import { parseNote } from "./parse";

export interface IngestStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunks: number;
  ms: number;
}

/** All .md files under dir, as paths relative to dir with forward slashes, sorted for determinism. */
export async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

/**
 * The text we embed for a chunk. Prepending the title and heading path ("contextual chunk
 * header") means a chunk that says "Handoff is Mondays at 10:00" still knows it is about on-call.
 */
export function embeddingText(title: string, headingPath: string, content: string): string {
  return `${headingPath.startsWith(title) ? headingPath : `${title} > ${headingPath}`}\n\n${content}`;
}

/**
 * Sync the database with a folder of notes. Incremental: unchanged files (same content hash
 * and same embedder) are skipped, changed files are re-chunked, deleted files are removed.
 * Each file is written in its own transaction so a crash never leaves half a document.
 */
export async function ingestDirectory(
  pool: pg.Pool,
  embedder: Embedder,
  dir: string = config.notesDir,
  chunkOpts: ChunkOptions = {
    maxTokens: config.chunkMaxTokens,
    minTokens: config.chunkMinTokens,
    overlapTokens: config.chunkOverlapTokens,
  },
  opts: { force?: boolean; log?: (msg: string) => void } = {},
): Promise<IngestStats> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const files = await listMarkdown(dir);
  const stats: IngestStats = { scanned: files.length, added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, ms: 0 };

  // The chunking settings are part of the hash: change the chunk size and every file re-chunks.
  const settings = JSON.stringify(chunkOpts);
  const existing = new Map<string, { hash: string; model: string }>(
    (await pool.query("SELECT path, content_hash, embed_model FROM documents")).rows.map((r) => [
      r.path,
      { hash: r.content_hash, model: r.embed_model },
    ]),
  );

  for (const rel of files) {
    const raw = await readFile(path.join(dir, rel), "utf8");
    const hash = createHash("sha256").update(settings).update(raw).digest("hex");
    const prev = existing.get(rel);
    existing.delete(rel);
    if (!opts.force && prev && prev.hash === hash && prev.model === embedder.name) {
      stats.unchanged++;
      continue;
    }

    const note = parseNote(rel, raw);
    const chunks = chunkNote(note, chunkOpts);
    const vectors = await embedder.embedDocuments(
      chunks.map((c) => embeddingText(note.title, c.headingPath, c.content)),
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO documents (path, title, frontmatter, content_hash, embed_model)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (path) DO UPDATE SET title = EXCLUDED.title, frontmatter = EXCLUDED.frontmatter,
           content_hash = EXCLUDED.content_hash, embed_model = EXCLUDED.embed_model, ingested_at = now()
         RETURNING id`,
        [rel, note.title, note.frontmatter, hash, embedder.name],
      );
      const docId = rows[0].id as number;
      await client.query("DELETE FROM chunks WHERE document_id = $1", [docId]);
      for (const [i, c] of chunks.entries()) {
        await client.query(
          `INSERT INTO chunks (document_id, chunk_index, heading_path, content, token_count, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [docId, c.index, c.headingPath, c.content, c.tokenCount, toPgVector(vectors[i])],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (prev) stats.updated++;
    else stats.added++;
    stats.chunks += chunks.length;
    log(`${prev ? "updated" : "added  "} ${rel} (${chunks.length} chunks)`);
  }

  // Whatever is left in `existing` is in the database but no longer on disk.
  for (const gone of existing.keys()) {
    await pool.query("DELETE FROM documents WHERE path = $1", [gone]);
    stats.removed++;
    log(`removed ${gone}`);
  }

  stats.ms = Date.now() - started;
  return stats;
}
