# Learning path

Read in this order. Times assume you read the doc, open each file it points to, run the commands, and
do at least one exercise. You already know backend and SQL, so the Postgres parts will be quick; spend
the saved time on the "Concepts" sections and the exercises.

| # | Read | Time | You will be able to explain |
|---|---|---|---|
| 0 | [README](../README.md) (top half), then [MORNING_SUMMARY](MORNING_SUMMARY.md) | 20 min | What was built, what was measured, and what was not |
| 1 | [01 Ingest](learn/01-ingest.md) | 1.5 h | Chunking, embeddings, cosine similarity, full-text search, incremental indexing |
| 2 | [02 Retrieve](learn/02-retrieve.md) | 2 h | Hybrid search, RRF, re-ranking, recall@k and MRR, and why a re-ranker can make things worse |
| 3 | [03 Answer](learn/03-answer.md) | 1.5 h | RAG prompts, citations, streaming, prompt caching, refusals, tokens and cost |
| 4 | [04 Agent](learn/04-agent.md) | 2 h | Tool use, the agent loop, hard stops, routing, traces |
| 5 | [05 Evals](learn/05-evals.md) | 2.5 h | Golden sets, deterministic grading vs LLM judges, judge calibration (kappa), CI gates |
| 6 | [06 Guardrails](learn/06-guardrails.md) | 2 h | Claim-level citation checks, fail-closed design, prompt injection and defence in depth |
| 7 | [07 Latency and cost](learn/07-latency-cost.md) | 1 h | p50/p95, TTFT, routing economics, where the time goes |
| 8 | [08 UI](learn/08-ui.md) | 1 h | SSE streaming, safe rendering of model output, deploying a private app |
| 9 | [DECISIONS](DECISIONS.md), skim all, read the ones you disagree with | 45 min | Why each choice was made and what would change it |

**Total: about 14 hours**, comfortably a week of evenings.

## Suggested rhythm

1. **Day 1 (stages 1-2).** Get it running (README "Run locally"), then read 01 and 02. Do exercise 1 of
   stage 1 (chunk size vs recall@k). This is the single most useful experiment in the repo.
2. **Day 2 (stage 3).** Get an API key and run `npm run ask` with Claude. Watch `cache_read` change
   between two runs.
3. **Day 3 (stage 4).** Run the agent on the summary and draft questions; read a trace in the `traces` table.
4. **Day 4 (stage 5).** Re-label `evals/judge-labels.jsonl` yourself, then run `npm run eval:full` with
   Claude and record the real numbers in the README.
5. **Day 5 (stages 6-8).** Try to break the guardrails (exercise 1 of stage 6), then the UI and deploy docs.

## Concepts index (where each idea is explained)

| Concept | Stage |
|---|---|
| tokens, chunking, overlap, contextual headers | 1 |
| embeddings, cosine similarity, HNSW / ANN index | 1, 2 |
| full-text search, BM25-style ranking | 1, 2 |
| hybrid search, Reciprocal Rank Fusion, cross-encoders | 2 |
| recall@k, MRR | 2, 5 |
| RAG, grounding, citations, refusals | 3 |
| streaming, prompt caching, effort | 3 |
| tool use, agent loop, hard stops, traces | 4 |
| model routing | 4, 7 |
| golden sets, LLM-as-judge, Cohen's kappa, regression gates | 5 |
| faithfulness, entailment, fail closed, prompt injection | 6 |
| p50/p95, time to first token, cost per question | 7 |
| Server-Sent Events, safe rendering, basic auth | 8 |
