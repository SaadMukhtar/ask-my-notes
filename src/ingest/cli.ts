import { config } from "../config";
import { closePools, getPool, migrate } from "../db/pool";
import { getEmbedder } from "../embed";
import { ingestDirectory } from "./ingest";

// Usage: npm run ingest [-- --dir ./my-notes] [-- --force]
const args = process.argv.slice(2);
const dirFlag = args.indexOf("--dir");
const dir = dirFlag >= 0 ? args[dirFlag + 1] : config.notesDir;
const force = args.includes("--force");

await migrate();
const pool = getPool();
const embedder = getEmbedder();
console.log(`Ingesting ${dir} with embedder ${embedder.name}`);
const stats = await ingestDirectory(pool, embedder, dir, undefined, { force, log: (m) => console.log("  " + m) });
const { rows } = await pool.query(
  "SELECT count(*)::int AS docs, (SELECT count(*)::int FROM chunks) AS chunks, (SELECT round(avg(token_count))::int FROM chunks) AS avg_tokens FROM documents",
);
console.log(
  `Done in ${stats.ms} ms: ${stats.added} added, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.removed} removed.`,
);
console.log(`Index now has ${rows[0].docs} documents, ${rows[0].chunks} chunks, ~${rows[0].avg_tokens} tokens per chunk.`);
await closePools();
