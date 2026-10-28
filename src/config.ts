import "dotenv/config";

// All configuration comes from environment variables (see .env.example) so the same code runs
// on a laptop, in CI, and in a container without edits. Defaults favour "works out of the box".
function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  databaseUrl: env("DATABASE_URL", "postgres://notes:notes@localhost:5432/notes"),
  notesDir: env("NOTES_DIR", "./corpus/sample"),
  embedder: env("EMBEDDER", "transformers") as "transformers" | "hash",
  reranker: env("RERANKER", "cross-encoder") as "cross-encoder" | "heuristic" | "none",
  llmProvider: env("LLM_PROVIDER", "anthropic") as "anthropic" | "offline",
  answerModel: env("ANSWER_MODEL", "claude-sonnet-5-5"),
  routerModel: env("ROUTER_MODEL", "claude-haiku-5-5"),
  port: Number(env("PORT", "8787")),
  // Chunking knobs live here so the stage-1 exercises can change them without touching code.
  chunkMaxTokens: Number(env("CHUNK_MAX_TOKENS", "220")),
  chunkMinTokens: Number(env("CHUNK_MIN_TOKENS", "60")),
  chunkOverlapTokens: Number(env("CHUNK_OVERLAP_TOKENS", "30")),
  traceDir: env("TRACE_DIR", "./data/traces"),
};

export type Config = typeof config;
