-- Ask My Notes schema. Safe to run repeatedly (everything is IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per markdown file. content_hash lets ingest skip files that did not change.
CREATE TABLE IF NOT EXISTS documents (
  id           SERIAL PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,          -- path relative to NOTES_DIR, e.g. docs/oncall-policy.md
  title        TEXT NOT NULL,
  frontmatter  JSONB NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  embed_model  TEXT NOT NULL,                 -- which embedder produced this doc's vectors
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per chunk: the unit we retrieve and cite.
CREATE TABLE IF NOT EXISTS chunks (
  id           SERIAL PRIMARY KEY,
  document_id  INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INT NOT NULL,
  heading_path TEXT NOT NULL,                 -- "Title > Section > Subsection"
  content      TEXT NOT NULL,
  token_count  INT NOT NULL,
  -- 384 dims matches bge-small-en-v1.5; the hash embedder is built to the same size so either
  -- embedder fits the column. Changing models means re-ingesting (ingest does this automatically).
  embedding    vector(384) NOT NULL,
  -- Full-text search vector. Headings get weight A, body weight B, so a match in a heading
  -- counts more. GENERATED means Postgres keeps it in sync; we never write it ourselves.
  tsv          tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', heading_path), 'A') ||
                 setweight(to_tsvector('english', content), 'B')
               ) STORED,
  UNIQUE (document_id, chunk_index)
);

-- HNSW is an approximate nearest-neighbour index. With ~100 chunks a sequential scan would be
-- just as fast, but the index is what you need at 100k chunks, so we set it up from day one.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_gin ON chunks USING gin (tsv);

-- Every answer / agent run is logged here (and as JSONL) so evals can replay and re-grade it.
CREATE TABLE IF NOT EXISTS traces (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,                  -- 'answer' | 'agent'
  question    TEXT NOT NULL,
  route       TEXT,                           -- 'easy' | 'hard'
  model       TEXT,
  status      TEXT NOT NULL,                  -- 'answered' | 'refused' | 'error'
  answer      TEXT,
  citations   JSONB NOT NULL DEFAULT '[]',
  steps       JSONB NOT NULL DEFAULT '[]',
  usage       JSONB NOT NULL DEFAULT '{}',
  cost_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  latency_ms  INT NOT NULL DEFAULT 0
);

-- Added in stage 7: time to first streamed token (what the user perceives as "it started answering").
ALTER TABLE traces ADD COLUMN IF NOT EXISTS ttft_ms INT;
