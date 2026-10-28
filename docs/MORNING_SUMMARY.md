# Morning summary

Good morning. Everything you asked for is built, tested, documented, and committed on branch
`claude/sleepy-goldberg-inyfw1`, one commit per stage. Two things in the build environment shaped what
I could *measure* (not what I could build), so read section 2 before you quote any number.

## 1. What got built

| Stage | What exists | Tests |
|---|---|---|
| 0 | 35 fictional notes (`corpus/sample/`, "Fernhill Foods" team), 3 with planted prompt injections; `NOTES_DIR` for your private notes (git-ignored) | - |
| 1 Ingest | heading-aware chunking (220/60/30 tokens), contextual headers, incremental ingest by content hash, Postgres + pgvector HNSW + generated tsvector | 14 |
| 2 Retrieve | vector + Postgres FTS, RRF fusion, pluggable re-ranker (cross-encoder / heuristic / none), per-signal explanations in `npm run search` | 13 |
| 3 Answer | streaming answers with `[S#]` citations, cached byte-stable system prompt, refusal sentence, traces in Postgres + JSONL, offline extractive baseline | 10 |
| 4 Agent | the exact graph from your brief: router (Haiku, heuristic fallback) → plan/act/observe with `search`, `read_page`, `draft_page` → verify → retry once → refuse; max 6 tool steps, token budget, per-tool and per-call timeouts | 18 |
| 5 Evals | 50-question golden set (lookup, multi-hop, reasoning, summary, draft, injection, unanswerable; 10 paraphrased), recall@k, deterministic grader + LLM judge (Sonnet, JSON schema), 24 hand-labelled answers for judge calibration, replay/regrade, GitHub Actions gate | 7 |
| 6 Guardrails | claim-level citation verifier (numbers, number+unit, word coverage, then Haiku), link allow-list, injection sanitiser that removes instruction-like sentences before the model reads them | 17 |
| 7 Latency/cost | TTFT + p50/p95 + tokens + cost in every trace, `report:latency`, router accuracy eval, cost estimate | 5 |
| 8 UI | React + Vite chat UI over SSE: live agent steps, citation chips, note drawer with highlight, cost/latency footer, drafts; optional basic auth; Dockerfile + compose; exact deploy steps in the README | 5 |

**89 tests, all passing** (including from a fresh clone with clean installs). Docs: 8 stage write-ups in
`docs/learn/`, 29 entries in `docs/DECISIONS.md`, `docs/LEARN_PATH.md`.

## 2. What blocked measurement (and how I handled it)

1. **No `ANTHROPIC_API_KEY`** in the environment. The Claude code paths follow the SDK docs, and every
   request shape is pinned by tests with a scripted fake model, but **no request reached the real API**.
   So I built an offline extractive baseline (`LLM_PROVIDER=offline`) to run the pipeline end to end, and
   I report its numbers *as the baseline*, never as Claude's.
2. **huggingface.co is blocked** by the environment's network policy, so the local embedding model and
   cross-encoder could not be downloaded. They remain the defaults in `.env.example`; every number here
   used the fallback hash embedder. To allow the host, edit the cloud environment's network access
   settings (https://code.claude.com/docs/en/cloud-environments#network-access).

## 3. The numbers (all real, measured 2026-10-28)

| Metric | Value |
|---|---|
| Retrieval recall@5, hybrid (46 answerable questions) | **97.8%** |
| Retrieval recall@1 / MRR: hybrid · vector · keyword | **79.3% / 0.877** · 68.5% / 0.794 · 75.0% / 0.851 |
| Heuristic re-ranker | made R@1 *worse* (72.8%), so it is off (a good lesson, see stage 2 doc) |
| End-to-end pass rate, offline baseline | **36.0%** (18/50); 34.0% before guardrails |
| Deterministic grader vs my labels | 91.7% agreement, kappa 0.83 |
| Lexical citation verifier on 39 labelled claims | 82.1% accuracy (75% of unsupported claims caught) |
| Injection detector | 15/15 attacks, 0/15 benign; 3/3 planted notes, 0/32 clean |
| Heuristic router vs difficulty labels | 86.0%; 64% of questions routed to Haiku |
| Pipeline overhead without the model | p95 ~11 ms per question |
| Claude cost per question | **estimate only:** ~$0.0044 routed + cached, ~$0.012 all Sonnet uncached |

**Not measured:** Claude's pass rate, LLM-judge agreement, the Haiku verifier and router, Claude p95
latency and real $/question, and retrieval with the neural embedder. One command each (with a key):

```bash
LLM_PROVIDER=anthropic npm run eval:full -- --write-baseline      # pass rate, p95, TTFT, $/question
npm run eval:judge-agreement -- --write-baseline                   # judge vs your labels
npm run eval:guardrails -- --write-baseline && npm run eval:router # Haiku verifier and router
EMBEDDER=transformers RERANKER=cross-encoder npm run ingest -- --force && npm run eval:retrieval
```

Then commit `evals/baseline.json` so CI's Claude job has a baseline to gate against, and update the
README "Numbers" tables. I'd expect Claude to beat the 36% floor by a wide margin on multi-hop, summary,
draft, and injection questions, but that is a prediction, not a number.

## 4. Known gaps (also in DECISIONS.md)

- **Untested against live services:** the Claude API, the transformers.js models, Docker/compose, and the
  deploy steps. The GitHub Actions workflow has not run yet either; I simulated its offline job locally
  from a fresh clone. It will run when you open a PR.
- **Optimistic guardrail and grader numbers:** I wrote the labels *and* the checks, and improved the checks
  after seeing failures (D-018, D-022). Treat 82% / 91.7% / 15-of-15 as dev-set numbers; add your own
  held-out examples.
- **Lexical verifier blind spot:** claims that reuse the source's words but swap who/what ("Tomás fixed
  it") pass the lexical tier, and the Haiku tier only re-checks claims the lexical tier *rejected* (D-020).
- **The corpus and golden set are small and clean.** Recall@5 is near the ceiling; real notes will score
  lower. The difficulty labels for the router are my judgment.
- **Closing the browser tab does not abort the agent run** (it finishes and is billed).
- **No server-side refusal fallback** (D-028); single-user basic auth only (D-026).

## 5. What to read first

1. `README.md`, the "Read this first" box and the Numbers section (10 min).
2. `docs/LEARN_PATH.md`, then `docs/learn/01-ingest.md` and `02-retrieve.md`. Do stage 1 exercise 1
   (chunk size vs recall@k); it's the best single experiment in the repo.
3. `src/agent/agent.ts`, the heart of the project: about 200 lines that map one-to-one onto your diagram.
4. `evals/judge-labels.jsonl`: re-label it yourself before trusting any judge number.
