import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests share one Postgres test database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { EMBEDDER: "hash", RERANKER: "heuristic", LLM_PROVIDER: "offline", TRACE_DIR: "./data/test-traces" },
  },
});
