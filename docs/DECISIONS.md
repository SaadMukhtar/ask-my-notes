# Decisions

One entry per decision. Newest last. Each entry: date, stage, decision, options considered, why,
tradeoffs, and what would make us change it.

---

## D-001: Fictional public sample corpus, private notes via NOTES_DIR
- **Date:** 2026-10-28 · **Stage:** 0
- **Decision:** Build and evaluate everything on 35 fictional notes in `corpus/sample/` (a made-up
  grocery company, "Fernhill Foods"). Private notes go in `NOTES_DIR`, which `.gitignore` covers when
  it is `./notes` or `./private-notes`.
- **Options:** (a) fictional corpus; (b) a public dataset such as Wikipedia; (c) the owner's own notes.
- **Why:** Public repo, so no private data. A purpose-written corpus gives answers we know exactly,
  which makes a precise golden set possible, and lets us plant prompt-injection docs.
- **Tradeoffs:** Small and clean. Real notes are messier (half sentences, stale facts, duplicates),
  so real-world numbers will be lower than the sample-corpus numbers.
- **Would change if:** we want to report generalisation; then add a second, messier corpus.

## D-002: Postgres + pgvector as the only datastore
- **Date:** 2026-10-28 · **Stage:** 1
- **Decision:** Documents, chunks, vectors, the full-text index, and traces all live in Postgres 16
  with pgvector (HNSW index, cosine distance).
- **Options:** pgvector; a dedicated vector DB (Qdrant, Pinecone, Weaviate); SQLite + sqlite-vec.
- **Why:** One system for vectors *and* keyword search *and* metadata, joined in SQL, in one
  transaction. Familiar to a backend engineer. HNSW is plenty fast below millions of vectors.
- **Tradeoffs:** Need the pgvector extension installed (Docker image `pgvector/pgvector:pg16` has it).
  At very large scale, a dedicated vector DB has better filtering and sharding.
- **Would change if:** more than ~10M chunks, or multi-tenant filtering becomes slow.

## D-003: Structure-aware chunking, 220/60/30 tokens
- **Date:** 2026-10-28 · **Stage:** 1
- **Decision:** Split on markdown structure (headings, paragraphs, lists, tables), pack into chunks of
  at most 220 estimated tokens, start new chunks at `##` boundaries once a chunk has 60 tokens, and
  overlap 30 tokens. Prepend title and heading path before embedding.
- **Options:** fixed-size character windows; sentence windows; one chunk per heading section;
  LLM-based "semantic" chunking.
- **Why:** Keeps tables and lists whole, keeps chunks coherent, and avoids one-line chunks in short
  notes. The contextual header is a cheap, well-known retrieval win.
- **Tradeoffs:** Token counts are estimated (chars/4), not exact. Overlap duplicates some text.
- **Would change if:** the chunk-size sweep in the stage 1 exercises shows a clearly better setting.

## D-004: Two embedders: local transformers.js (default) and a hashing embedder (fallback)
- **Date:** 2026-10-28 · **Stage:** 1
- **Decision:** Default `EMBEDDER=transformers` runs `Xenova/bge-small-en-v1.5` locally through
  transformers.js (384 dims, q8 quantised, no API key). `EMBEDDER=hash` is a feature-hashing
  embedder (stemmed words, word pairs, character trigrams hashed into 384 dims).
- **Options:** hosted embedding API (Voyage, OpenAI): needs another key and costs per call;
  transformers.js local model; hashing; TF-IDF with a fitted vocabulary.
- **Why:** The brief asked for a free local model, so bge-small via transformers.js is the default.
  **The sandbox that built this repo could not reach huggingface.co (blocked by its network policy),
  so the model weights could not be downloaded there.** The hash embedder lets the pipeline run and be
  measured anyway, and it is fully deterministic, which CI likes.
- **Tradeoffs:** The hash embedder only captures shared words and fragments, not meaning. **All
  numbers recorded in this repo were measured with `EMBEDDER=hash`.** The transformers path is written
  against the documented transformers.js API but was not executed in the build sandbox.
- **Would change if:** you run with network access: `EMBEDDER=transformers npm run ingest -- --force`
  then `npm run eval:retrieval`, and record the new numbers next to the hash ones.

## D-005: Hybrid retrieval with Reciprocal Rank Fusion
- **Date:** 2026-10-28 · **Stage:** 2
- **Decision:** Run vector search and Postgres full-text search (OR query, `ts_rank_cd`), 30
  candidates each, and fuse with RRF (k = 60).
- **Options:** vector only; keyword only; weighted sum of normalised scores; RRF.
- **Why:** Measured: hybrid R@1 79.3% vs 68.5% (vector) and 75.0% (FTS); MRR 0.877 vs 0.794 / 0.851.
  RRF needs no score normalisation or weight tuning.
- **Tradeoffs:** Two queries per search (both ~1-3 ms here). RRF ignores score margins.
- **Would change if:** a learned fusion or a strong cross-encoder makes the fusion method irrelevant.

## D-006: Re-ranker is pluggable and off unless it wins
- **Date:** 2026-10-28 · **Stage:** 2
- **Decision:** `RERANKER=cross-encoder` (local ms-marco-MiniLM-L-6-v2) is the default in
  `.env.example`; `heuristic` and `none` are alternatives. The build sandbox runs `none`.
- **Options:** cross-encoder; LLM re-ranking with Haiku; feature-based heuristic; none.
- **Why:** The cross-encoder is the standard choice and free to run locally, but it could not be
  downloaded in the sandbox. The heuristic re-ranker measured **worse** than plain hybrid on R@1
  (72.8% vs 79.3%) and MRR (0.855 vs 0.877), with equal R@5, so it is not used by default.
- **Tradeoffs:** Cross-encoder adds ~50-200 ms on CPU for 30 candidates (an estimate, not
  measured here). LLM re-ranking adds an API call and cost to every question.
- **Would change if:** `EMBEDDER=transformers RERANKER=cross-encoder npm run eval:retrieval` shows a
  win on your machine; then make it the default and write a new baseline.

## D-007: Golden set built in stage 2; recall measured per document
- **Date:** 2026-10-28 · **Stage:** 2
- **Decision:** Write the 50-question golden set (`evals/golden.jsonl`) now, not in stage 5, and
  measure recall at the document level over the top-k chunks. 10 questions are deliberately
  paraphrased; 4 are unanswerable; 3 target prompt-injection docs; 2 are drafting tasks.
- **Options:** chunk-level relevance labels; LLM-generated questions; doc-level labels.
- **Why:** Retrieval cannot be tuned blind. Chunk-level labels break every time chunk size
  changes. Hand-written questions with known answers beat synthetic ones for a small corpus.
- **Tradeoffs:** Doc-level recall can count a hit when the right doc's *wrong* chunk was retrieved.
  The golden set was written by the same author as the corpus, which biases it toward the corpus's
  phrasing (partly offset by the paraphrased subset).
- **Would change if:** the corpus grows; then add chunk-level labels for a subset, and a dev/test split.

## D-008: One LLM interface; an offline extractive baseline for no-key runs
- **Date:** 2026-10-28 · **Stage:** 3
- **Decision:** All model calls go through `LLM.stream()`. `AnthropicLLM` uses the official SDK.
  `OfflineLLM` (`LLM_PROVIDER=offline`) is a deterministic extractive stand-in that speaks the same
  message shape (it even issues tool calls in stage 4).
- **Options:** call the SDK directly everywhere; mock only in tests; a provider-neutral framework (LangChain).
- **Why:** **No `ANTHROPIC_API_KEY` was available in the build environment.** The offline baseline
  lets the whole pipeline (agent loop, guardrails, UI, CI) run and be tested end to end, and it gives
  the evals a floor that Claude must beat. Tests use a scripted `FakeLLM` to pin exactly what we send.
- **Tradeoffs:** Every number measured with the offline baseline describes the *baseline*, not Claude,
  and is labelled that way. The real Claude path is written to the SDK docs but was not executed
  against the live API in this environment.
- **Would change if:** never remove the offline mode (it is what CI without secrets uses), but run
  `npm run eval:full` with a key and record Claude's numbers next to the baseline's.

## D-009: `[S#]` citation markers instead of the API's native citations
- **Date:** 2026-10-28 · **Stage:** 3
- **Decision:** Sources are rendered as `<source id="S1" ...>` blocks; the model cites `[S1]`.
- **Options:** the Messages API citations feature (document blocks with `citations: {enabled: true}`,
  or search-result blocks), which returns exact `cited_text` spans; JSON output with claim/source pairs.
- **Why:** Works identically for one-shot answers, agent tool results, and the offline baseline;
  keeps the streamed text plain; trivial to parse and to verify sentence by sentence in stage 6.
- **Tradeoffs:** The model can cite an id that does not support the claim (or does not exist).
  Native citations guarantee the quoted span exists. We compensate with stage 6 verification.
- **Would change if:** verification shows many bad citations; native citations would give exact
  spans to verify against.

## D-010: Prompt caching layout
- **Date:** 2026-10-28 · **Stage:** 3
- **Decision:** Byte-stable system prompt with an explicit `cache_control` breakpoint in one-shot
  answers; the agent loop (stage 4) additionally uses top-level automatic caching so each step
  re-reads the previous steps' prefix from cache.
- **Options:** no caching; caching the retrieved sources (they change every question, so no).
- **Why:** The system prompt (~700 tokens) is identical on every call. In the agent, the conversation
  prefix grows each step and is re-sent each step; caching makes step N pay ~10% for steps 1..N-1.
- **Tradeoffs:** Cache writes cost 1.25x, so a one-off question with no follow-up within 5 minutes pays
  a little more. Not verified against the live API here (no key); check `cache_read` in traces.
- **Would change if:** traces show `cache_read_input_tokens` staying 0; then audit the prefix for
  something that varies.

## D-011: Hand-written agent loop, not the SDK Tool Runner
- **Date:** 2026-10-28 · **Stage:** 4
- **Decision:** `runAgent()` is a manual `while` loop over `client.messages.stream()`.
- **Options:** SDK beta Tool Runner (`client.beta.messages.toolRunner`); Claude Agent SDK; LangGraph.
- **Why:** The required graph has custom branches (route before the loop, verify after it, retry once,
  refuse on hard stops), and the point of the repo is to make each branch readable and testable.
- **Tradeoffs:** We own `pause_turn`/edge-case handling the Tool Runner would do for us.
- **Would change if:** the loop grows past what is readable; the Tool Runner's hooks can host the
  verify/budget logic.

## D-012: Hard stops: 6 tool steps, 60k-token budget, 5 s per tool, 60 s per model call
- **Date:** 2026-10-28 · **Stage:** 4
- **Decision:** As stated; configurable through `AgentOptions` and `TOKEN_BUDGET`.
- **Why:** 6 steps covers search + re-search + 2 page reads + draft with room to spare on this corpus.
  60k tokens bounds worst-case cost at about $0.12-0.60 per question on Sonnet 5.5 (cached input is
  ~$0.20/M, fresh input $2/M; budget math counts cache reads as tokens). Tools are local Postgres
  queries (ms), so 5 s only trips on a real problem.
- **Tradeoffs:** A budget counted in tokens, not dollars, treats cheap cache reads like fresh input.
- **Would change if:** traces show legitimate questions hitting a limit.

## D-013: draft_page writes to data/drafts, never into NOTES_DIR
- **Date:** 2026-10-28 · **Stage:** 4
- **Decision:** Drafts go to a git-ignored `data/drafts/` folder for human review.
- **Why:** An agent that writes into the corpus it searches can pollute later answers (including with
  text that came from an injected document). Human review is the gate.
- **Would change if:** an approval flow exists in the UI ("save to notes" button).

## D-014: LLM router (Haiku) with a heuristic fallback
- **Date:** 2026-10-28 · **Stage:** 4
- **Decision:** With a key, Haiku classifies EASY/HARD (thinking off, 16 max tokens); on any failure
  or unexpected reply, regex rules decide. Offline runs use the rules.
- **Options:** rules only (free, instant); LLM only; embedding classifier trained on labelled questions.
- **Why:** The brief asks for Haiku routing; the fallback keeps routing from ever blocking an answer.
- **Tradeoffs:** The LLM router adds one small call (~$0.00002, a few hundred ms) per question.
  Stage 7 measures the heuristic's accuracy against the golden set's difficulty labels.
- **Would change if:** the heuristic matches the LLM router's accuracy; then drop the extra call.

## D-015: Two graders; the headline pass needs both
- **Date:** 2026-10-28 · **Stage:** 5
- **Decision:** Every answer gets a deterministic grade (key facts, forbidden strings, citations,
  refusal) and, with a key, an LLM-judge grade. The headline "pass" requires both.
- **Options:** judge only; deterministic only; judge with deterministic as a tie-breaker.
- **Why:** On the labelled set the deterministic grader's only errors are false passes on answers
  that contain the right strings but say something wrong; the judge targets exactly that. The
  deterministic grader catches forbidden injected content and missing citations the judge ignores.
- **Tradeoffs:** "Both" is stricter, so pass rates read lower than judge-only numbers you may see
  elsewhere. The judge costs one extra Sonnet call per question.
- **Would change if:** judge-vs-human agreement turns out low; then lean on deterministic checks and
  tighten the rubric.

## D-016: Sonnet 5.5 as the judge, rubric versioned
- **Date:** 2026-10-28 · **Stage:** 5
- **Decision:** The judge uses `ANSWER_MODEL` (Sonnet 5.5), low effort, JSON-schema output with the
  reasoning before the verdict, and a cached rubric tagged `judge-v1`.
- **Options:** Haiku (cheaper, weaker); Opus (stronger, ~2x price); a different vendor's model (less
  self-preference bias).
- **Why:** Strong enough for a fact-checking rubric at a reasonable price.
- **Tradeoffs:** The same model family judging its own answers may be lenient (self-preference).
  Not measured here: no key.
- **Would change if:** judge-vs-human agreement is below ~85%; try Opus 5.5 as judge.

## D-017: CI gates offline (always) and Claude (when a secret exists)
- **Date:** 2026-10-28 · **Stage:** 5
- **Decision:** The `offline` job runs tests, retrieval eval, guardrail eval, and the offline end-to-end
  eval with zero tolerance. The `claude` job runs the real eval and judge only if the repo has an
  `ANTHROPIC_API_KEY` secret, gating with a 3-question tolerance.
- **Why:** Forks and keyless repos still get a meaningful, free, deterministic gate on everything
  except model quality. Model quality is gated where it can be.
- **Tradeoffs:** The Claude gate needs a baseline recorded once with a key
  (`npm run eval:full -- --write-baseline`, then commit `evals/baseline.json`). Until then it reports
  "no baseline; skipping". Each Claude CI run costs money.
- **Would change if:** CI cost matters: run the Claude job nightly or on a label instead of every PR.

## D-018: Grader v2 matches key facts at word starts
- **Date:** 2026-10-28 · **Stage:** 5
- **Decision:** `must_include` alternatives must start at a word boundary ("5 minutes" no longer
  matches "15 minutes"). q21's key fact became "two|2 approval".
- **Why:** The labelled set showed v1 passing a wrong answer (L04). Agreement went from 87.5% (kappa
  0.75) to 91.7% (kappa 0.83).
- **Tradeoffs:** The fix was found *using* the calibration set, so 91.7% is now an optimistic estimate.
  Add fresh labels to get an unbiased one.
- **Would change if:** new labels expose other systematic misses.
