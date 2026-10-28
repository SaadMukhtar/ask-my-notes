# Stage 1: Ingest

> Turn a folder of markdown notes into rows in Postgres: one row per document, one row per
> **chunk**, each chunk with an **embedding** and a **full-text search vector**.

## 1. What this stage does

An LLM cannot read your whole notes folder on every question. That would be slow, expensive, and
eventually too big for its context window. So we cut the notes into small pieces once, ahead of
time, and later fetch only the few pieces that matter for a question.

Tiny example. This note:

```markdown
# On-call policy
## Rotation
- Handoff is Mondays at 10:00 Pacific.
## Escalation
1. The primary has 5 minutes to acknowledge a page.
```

becomes chunks like:

| chunk | heading_path | content |
|---|---|---|
| 0 | `On-call policy` | `# On-call policy ## Rotation - Handoff is Mondays at 10:00 Pacific.` |
| 1 | `On-call policy > Escalation` | `## Escalation 1. The primary has 5 minutes...` |

Each chunk also gets a 384-number vector (its embedding) and a Postgres `tsvector` (its keywords).

## 2. Concepts

**Chunk.** A passage small enough to be specific but big enough to make sense alone.
*Analogy:* index cards. A whole book on one card is useless, and so is one word per card.

**Chunk size and overlap.** We aim for at most ~220 tokens per chunk, merge sections smaller than
~60 tokens into their neighbour, and copy the last ~30 tokens of each chunk into the start of the
next one. *Analogy:* overlapping photos for a panorama: the overlap makes sure nothing that sits on
a seam gets lost.

**Token.** The unit LLMs read; roughly 4 characters of English. We estimate tokens as
`chars / 4` for sizing. Billing uses the exact counts the API returns.

**Contextual chunk header.** Before embedding, we put the note title and heading path in front of
the chunk text (`On-call policy > Escalation`). *Analogy:* writing the chapter name at the top of
each index card, so the card still makes sense after it is shuffled.

**Embedding.** A list of numbers (a vector) that places text in a "meaning space", where similar
texts are close together. *Analogy:* GPS coordinates for meaning. "Page the secondary" and
"escalate to backup on-call" land near each other even though they share no words.

**Cosine similarity.** How we measure "close": the cosine of the angle between two vectors. 1 means
same direction, 0 means unrelated. With unit-length vectors it is just the dot product.

**Full-text search (FTS).** Postgres's built-in keyword search. `to_tsvector('english', text)`
turns text into stemmed keywords ("rotations" -> "rotat"), and `ts_rank` scores matches.
*Analogy:* the index at the back of a book.

**Incremental ingest.** We hash each file (plus the chunk settings). If the hash and the embedder
are the same as last time, we skip the file. *Analogy:* `make` only rebuilding files that changed.

## 3. Code walkthrough (read in this order)

1. `src/config.ts`: every knob (database URL, notes dir, embedder, chunk sizes) comes from env vars.
2. `src/db/schema.sql`: three tables.
   - `documents`: one row per file, with `content_hash` and `embed_model`.
   - `chunks`: text, `heading_path`, `embedding vector(384)`, and a *generated* `tsv` column, so
     Postgres keeps the keyword index in sync for us. Headings are weighted `A`, body `B`.
   - `traces`: used from stage 3 onward.
   An HNSW index serves vector search; a GIN index serves full-text search.
3. `src/db/pool.ts`: `getPool()` (one pg pool per URL), `migrate()` (runs the schema),
   `toPgVector()` (pgvector's `'[0.1,0.2]'` literal format).
4. `src/ingest/parse.ts`: `parseNote()` splits frontmatter (gray-matter) from the body, then walks
   lines, keeping a heading stack so every paragraph/list/table knows its heading path. It ignores
   `#` inside code fences. Title comes from frontmatter, then the first H1, then the filename.
5. `src/ingest/chunk.ts`: `chunkNote()` packs blocks into chunks (rules are in the comment at the
   top of the function). `splitOversized()` handles a single block bigger than the limit (lines,
   then sentences, then words). `tail()` builds the overlap.
6. `src/embed/text.ts`: the tokenizer, stopwords, and a tiny stemmer, shared with later stages.
7. `src/embed/hash.ts` and `src/embed/transformers.ts`: the two embedders (see decisions below).
   `src/embed/index.ts` picks one based on `EMBEDDER`.
8. `src/ingest/ingest.ts`: `ingestDirectory()` lists files, skips unchanged ones, embeds chunks, and
   writes each document in its own transaction. It also deletes rows for files that were deleted.
   `embeddingText()` builds the contextual header.
9. `src/ingest/cli.ts`: the `npm run ingest` entry point.

## 4. Decisions

- **Chunk on structure, not fixed character windows.** Notes have headings; a chunk that respects
  them reads like a coherent passage. Alternative: fixed 500-character windows (simpler, but cuts
  tables and lists in half). See DECISIONS.md D-003.
- **~220 tokens max, 60 min, 30 overlap.** Our notes are short (about 170 words each), so smaller
  chunks would turn every bullet into its own chunk. You will tune this in the exercises.
- **Postgres for everything** (documents, vectors, keywords, traces). Alternative: a separate vector
  database (Pinecone, Qdrant). One system means one backup, one transaction, and SQL joins between
  vectors and metadata. See D-002.
- **Two embedders.** `transformers` (local bge-small-en-v1.5, the default) and `hash`
  (feature hashing, no model download). The sandbox that built this repo could not reach Hugging
  Face, so every number recorded in this repo uses `hash`. See D-004.

## 5. Run it

```bash
# once: start Postgres with pgvector (see README "Run locally"), then
cp .env.example .env
npm install
npm run ingest
```

Expected output (hash embedder):

```
Ingesting ./corpus/sample with embedder hash-v1
  added   README.md (1 chunks)
  ...
Done in ~400 ms: 35 added, 0 updated, 0 unchanged, 0 removed.
Index now has 35 documents, 84 chunks, ~113 tokens per chunk.
```

Run it again: `35 unchanged`. Look inside:

```bash
psql "$DATABASE_URL" -c "select d.path, c.chunk_index, c.heading_path, c.token_count from chunks c join documents d on d.id = c.document_id order by 1, 2 limit 10;"
```

Tests: `npx vitest run tests/stage1-ingest.test.ts`.

## 6. Exercises

1. Set `CHUNK_MAX_TOKENS=80` in `.env`, run `npm run ingest`, and count chunks. Then run
   `npm run eval:retrieval` (stage 2) before and after. Does recall@5 go up or down, and why?
2. Set `CHUNK_OVERLAP_TOKENS=0` and re-ingest. Find a fact in the corpus that sits on a chunk
   boundary (hint: `docs/oncall-policy.md`). Can `npm run search` still find it?
3. Remove the contextual header (make `embeddingText()` return just `content`), re-ingest with
   `--force`, and re-run the retrieval eval. Which questions got worse?

## 7. Interview questions

1. **Why chunk documents at all instead of sending whole files?** Context limits, cost, and
   precision: the model answers better from 5 relevant passages than from 50 pages with the answer
   buried in the middle.
2. **How do you pick a chunk size?** Empirically: build a retrieval eval (recall@k), sweep sizes,
   and pick the best. Too small loses context, too large dilutes the embedding and wastes tokens.
3. **What does chunk overlap buy you, and what does it cost?** Facts on a boundary stay retrievable;
   the cost is duplicated tokens in the index and sometimes duplicated results.
4. **How do you keep the index in sync with changing files?** Content hashing for incremental
   updates, delete rows for removed files, and re-embed everything when the embedding model changes
   (vectors from different models are not comparable).
5. **Why store vectors in Postgres instead of a vector database?** At this scale (and up to a few
   million vectors) pgvector with HNSW is fast enough, and you keep transactions, joins, and one
   operational system. A dedicated vector DB wins at very large scale or with heavy filtering needs.
