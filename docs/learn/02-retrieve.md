# Stage 2: Retrieve

> Given a question, find the handful of chunks most likely to contain the answer, using two
> different search methods, fusing their results, and (optionally) re-ranking.

## 1. What this stage does

```
question ──► embed ──► vector search (top 30) ─┐
        └──────────► keyword search (top 30) ──┴─► RRF fusion ──► [re-rank] ──► top 5 chunks
```

Tiny example: *"How long were customers unable to pay for their orders on August 14?"*

- Keyword search looks for `customers`, `unable`, `pay`, `orders`, `august`, `14`. It finds the
  INC-2041 write-up because it contains "August 14" and "customers".
- Vector search looks for chunks whose embedding points in a similar direction.
- Fusion puts chunks that *both* methods liked at the top. The INC-2041 summary ("For **47
  minutes** ... customers could not complete checkout") comes out first.

Try it: `npm run search -- "How long were customers unable to pay on August 14?"`

## 2. Concepts

**Semantic (vector) search.** Embed the question with the same model as the chunks, then return the
chunks with the highest cosine similarity. *Analogy:* asking a librarian who understands what you
mean, even if you use different words than the book does.

**Keyword (lexical) search, BM25-style.** Postgres FTS with `ts_rank_cd`: more matching words,
rarer words, and words close together score higher. *Analogy:* Ctrl-F, but smarter. It is unbeatable
for exact strings like `max_client_conn` or `INC-2041`, which embeddings often blur.

**Hybrid search.** Run both and combine them. Each covers the other's blind spot: keywords miss
paraphrases, embeddings miss exact identifiers and rare names.

**Reciprocal Rank Fusion (RRF).** Combine ranked lists using only rank positions:
`score = Σ 1 / (60 + rank)`. *Analogy:* merging two "top 10" lists from two critics. You do not
need to know how each critic scores, only the order they gave.

**Re-ranking.** First-stage retrieval is tuned for *recall* (do not miss anything) over the whole
corpus, so it must be cheap. A re-ranker looks at only ~30 candidates and scores each
(question, chunk) pair more carefully. A **cross-encoder** is a small model that reads both texts
together and outputs a relevance score. *Analogy:* a quick CV screen (first stage) followed by
interviews for the shortlist (re-rank).

**ANN index (HNSW).** "Approximate nearest neighbour": a graph index that finds close vectors
without comparing against every row. It trades a tiny bit of accuracy for big speed at scale.

**recall@k.** Of the documents needed to answer, what fraction appear in the top k results?
recall@5 = 1.0 means every needed note was in the 5 chunks the model will see.
*Analogy:* did the search put the right files on your desk?

**MRR (mean reciprocal rank).** Average of 1/rank of the first relevant result. 1.0 means the right
note was always first; 0.5 means usually second.

## 3. Code walkthrough (read in this order)

1. `src/retrieve/types.ts`: `Hit` (one result) carries `signals`, the per-retriever ranks, so you can
   always see *why* something ranked where it did.
2. `src/retrieve/vector.ts`: `vectorSearch()`: one SQL query, `ORDER BY embedding <=> $1`. `<=>` is
   pgvector's cosine distance.
3. `src/retrieve/fulltext.ts`: `toOrQuery()` turns a question into `term | term | term` (and strips
   any characters that could break tsquery syntax). `fullTextSearch()` ranks with `ts_rank_cd`.
4. `src/retrieve/hybrid.ts`: `reciprocalRankFusion()`, about 20 lines.
5. `src/retrieve/rerank.ts`: three re-rankers behind one interface:
   - `CrossEncoderReranker`: local `Xenova/ms-marco-MiniLM-L-6-v2` (default in `.env.example`).
   - `HeuristicReranker`: a transparent, feature-based scorer (term coverage weighted by IDF,
     heading match, word-pair overlap, exact identifiers).
   - `NoopReranker`.
6. `src/retrieve/search.ts`: `search()` wires it all together and records timings.
   `pipelineMode()` decides whether the app re-ranks (only if a re-ranker is configured).
7. `src/eval/metrics.ts` and `evals/run-retrieval.ts`: the recall@k / MRR / latency eval, run per
   mode so you can see what each stage adds.
8. `evals/golden.jsonl`: the 50 questions (built in this stage because you cannot tune retrieval
   without measuring it; stage 5 builds the rest of the eval on top).

## 4. Decisions

- **Hybrid with RRF** instead of either retriever alone or a weighted score sum (D-005).
- **OR-query for FTS**, because AND-ing every word of a natural-language question usually matches nothing.
- **Re-ranking is optional and must earn its place** (D-006). With the hash embedder, the heuristic
  re-ranker *did not* beat plain hybrid (table below), so the sandbox config runs `RERANKER=none`.
- **Doc-level recall over top-k chunks** (D-007): chunk ids change with chunk size; documents don't.
- **10 of the 50 questions are paraphrased** so they share few words with the notes. A golden set
  written by copying phrases from the docs flatters keyword search.

### Measured results (hash embedder, 46 answerable questions, 2026-10-28)

| mode | R@1 | R@3 | R@5 | R@10 | MRR | p95 ms |
|---|---|---|---|---|---|---|
| vector (hash) | 68.5% | 89.1% | 95.7% | 95.7% | 0.794 | 3.6 |
| keyword (FTS) | 75.0% | 93.5% | 95.7% | 97.8% | 0.851 | 2.3 |
| **hybrid (RRF)** | **79.3%** | 95.7% | **97.8%** | 100% | **0.877** | 3.5 |
| hybrid + heuristic re-rank | 72.8% | 97.8% | 97.8% | 100% | 0.855 | 5.5 |

Paraphrased questions (n=10), R@1: vector 70%, FTS 60%, hybrid 70%, re-rank 80%.
Literal questions (n=36), R@1: vector 68%, FTS 79%, hybrid 82%, re-rank 71%.

How to read this:
- Hybrid beats both single retrievers on R@1 and MRR. That is the main lesson of the stage.
- Recall@5 is near the ceiling because the corpus is small (84 chunks). The interesting metric here
  is R@1 and MRR: *is the right note first?*
- The heuristic re-ranker helps paraphrased questions but hurts literal ones. It gets fooled by
  keyword-dense chunks (the glossary, the prompt-injection emails). Its weights were set by
  reasoning; tuning them on these 50 questions would overfit the test set.
- The hash "vector" search is really a second lexical method, so hybrid gains here understate what
  a neural embedder adds. Re-run with `EMBEDDER=transformers` to see the real semantic contribution.

## 5. Run it

```bash
npm run search -- "what caused INC-2041?"                # app pipeline
npm run search -- "what caused INC-2041?" --mode vector  # one retriever only
npm run eval:retrieval                                    # the table above
npm run eval:retrieval -- --gate                          # what CI runs: fails if recall@5 drops > 2 pts
```

Each result line shows its signals, e.g. `(vec#1 fts#1 rrf=0.0328)`: rank 1 in both lists.

## 6. Exercises

1. Change the RRF constant in `reciprocalRankFusion()` from 60 to 1, then 1000. Re-run the eval.
   What happens to R@1, and why does a small k make RRF behave like "trust whoever ranked it first"?
2. Switch `toOrQuery()` to AND (`" & "`) and re-run. How many questions now return zero keyword hits?
3. Set `RERANKER=heuristic` and look at q45 ("What is the on-call escalation policy?") with
   `npm run search`. Which chunk wins and why? Propose one feature that would fix it without
   breaking q09.

## 7. Interview questions

1. **Why hybrid search instead of only embeddings?** Embeddings capture meaning but blur exact
   tokens (IDs, error codes, names); keyword search is the reverse. Combining them gives better
   recall on both kinds of queries, which is why most production RAG systems use both.
2. **Why RRF rather than adding normalised scores?** Scores from different retrievers are on
   incomparable scales and distributions; RRF uses ranks only, needs no tuning, and is robust.
3. **What is a cross-encoder and why not use it for first-stage retrieval?** It scores a query and a
   document jointly (more accurate) but must run once per pair, so it cannot scan a whole corpus;
   bi-encoders (embeddings) precompute document vectors once.
4. **How do you evaluate retrieval separately from generation?** A golden set of questions with the
   documents that answer them; measure recall@k and MRR. It is cheap, deterministic, and tells you
   whether a bad answer is a retrieval problem or a generation problem.
5. **Your re-ranker made results worse. What do you do?** Look at per-question diffs (wins vs
   losses), find the failure pattern (here: dense keyword lists win on coverage), fix the feature or
   drop the re-ranker, and avoid tuning on the test set (keep a dev split, or add new questions).
