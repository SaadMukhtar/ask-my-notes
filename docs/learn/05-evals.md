# Stage 5: Evals

> Measure quality with numbers instead of vibes: a 50-question golden set, recall@k for
> retrieval, two graders for answers (code checks + an LLM judge), a human-labelled set to check
> the graders, and a CI job that fails a pull request when the numbers drop.

## 1. What this stage does

Every change to an AI system (a prompt tweak, a chunk size, a model) can silently make some answers
worse while making others better. An eval answers "did this change help, overall?" in one command.

```
evals/golden.jsonl (50 questions)
   ├─► npm run eval:retrieval        recall@1/3/5/10, MRR, latency      (no LLM, free, deterministic)
   ├─► npm run eval:full             agent answers → graders → pass rate, refusals, p95, $/question
   │       ├─ deterministic grader   must_include / must_not_include / refused? / cited?
   │       └─ LLM judge              rubric-based PASS/FAIL with a reason (needs a key)
   └─► npm run eval:judge-agreement  graders vs human labels on 24 hand-labelled answers
CI: .github/workflows/evals.yml runs all of it on every PR and fails on a regression.
```

A golden-set row:

```json
{"id": "q37", "question": "What were the rollback criteria for the Harbor cutover?",
 "type": "lookup", "difficulty": "hard", "paraphrased": false,
 "expected_docs": ["meetings/2026-10-02-harbor-go-no-go.md"],
 "must_include": ["2%", "5 minutes"], "must_not_include": [], "should_refuse": false,
 "reference_answer": "Roll back if checkout error rate is above 2% for 5 minutes ..."}
```

## 2. Concepts

**Golden set.** A fixed list of questions with known-good answers. *Analogy:* a regression test
suite, except each "assertion" is fuzzy. Ours mixes lookups, multi-hop, reasoning, summaries, drafts,
prompt-injection probes, and 4 unanswerable questions (where the right answer is "I don't know").

**recall@k / MRR.** Covered in stage 2. They isolate retrieval: if recall is high but answers are bad,
the problem is generation, not search.

**Deterministic (code-based) grading.** Check that key facts appear as substrings, that forbidden text
does not, that the answer cites something, and that refusals happen exactly when they should.
Cheap, exactly reproducible, and blind to meaning: "$1,200 per *month*" passes a check for "1,200".

**LLM-as-judge.** A model grades the answer against the reference using a written rubric and explains
its verdict. It catches meaning errors substring checks cannot. Its weaknesses: it costs money, it is
not perfectly consistent, and it may favour answers that sound like itself.
*Analogy:* a teaching assistant with a marking scheme, versus an answer-key scanner.

**Calibrating the judge.** You only trust a grader after measuring it against humans. We hand-labelled
24 answers (12 good, 12 bad, several adversarial) and compute **agreement** and **Cohen's kappa**
(agreement corrected for luck: 0 = chance, 1 = perfect, above ~0.8 is strong).

**Regression gate.** CI compares the new numbers with `evals/baseline.json` and fails if they drop by
more than a tolerance. Deterministic runs get zero tolerance; LLM runs vary between runs, so they get
3 questions of slack.

**Replay.** Every eval run saves its rows (answers, citations, trace ids). `npm run eval:regrade`
re-grades a saved run after you change the golden set or the rubric, without paying for the agent again.

## 3. Code walkthrough (read in this order)

1. `evals/golden.jsonl` and `src/eval/golden.ts`: the data and its type.
2. `src/eval/metrics.ts`: recall@k, reciprocal rank, mean, percentile.
3. `evals/run-retrieval.ts`: per-mode retrieval table, `--gate`, `--write-baseline`.
4. `src/eval/grade.ts`: `gradeDeterministic()`, `containsTerm()` (word-start matching, see D-018).
5. `src/eval/judge.ts`: `JUDGE_SYSTEM` (the rubric), `judge()` (structured JSON output, cached rubric),
   `agreement()` (accuracy, kappa, confusion counts).
6. `src/eval/full.ts`: `runFullEval()` → rows; `pass()` (headline: judge AND deterministic when a judge
   ran); `summarise()` (pass rate, refusal accuracy, per-type and per-route numbers, p50/p95, cost).
7. `evals/run-full.ts`, `evals/regrade.ts`, `evals/run-judge-agreement.ts`: the CLIs.
8. `evals/judge-labels.jsonl`: the labelled answers. **Re-label them yourself**: change `human_label`
   and `labeler`, then re-run `npm run eval:judge-agreement`.
9. `.github/workflows/evals.yml`: the `offline` job (always) and the `claude` job (only if the repo
   has an `ANTHROPIC_API_KEY` secret).

## 4. Decisions

- Two graders, and the headline needs both (D-015).
- Sonnet 5.5 as judge, with the rubric versioned (D-016).
- CI gates on a deterministic offline run always, plus Claude when a secret exists (D-017).
- Grader v2 matches at word starts, a fix found by the labelled set (D-018).

## 5. Run it and the real numbers

```bash
npm run eval:retrieval
npm run eval:judge-agreement
LLM_PROVIDER=offline npm run eval:full
# with a key (costs money; see stage 7 for $/question):
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run eval:full
```

Measured in the build sandbox (2026-10-28; no API key was available, so nothing below is Claude):

| What | Result |
|---|---|
| Retrieval, hybrid, hash embedder | R@1 79.3%, R@5 97.8%, MRR 0.877 (46 answerable questions) |
| Deterministic grader vs human labels (v2) | 91.7% agreement, kappa 0.83 (24 labels) |
| Deterministic grader vs human labels (v1, plain substrings) | 87.5% agreement, kappa 0.75 |
| LLM judge vs human labels | **not measured** (needs a key) |
| End-to-end pass rate, offline extractive baseline | **34.0% (17/50)**, 2/4 unanswerable refused, 15/46 answerable wrongly refused |
| End-to-end pass rate, Claude | **not measured** (needs a key) |

The baseline's 34% is the floor: it is what "copy the best-matching sentences" achieves. It fails every
multi-hop, summary, draft, and injection question, which is exactly where an LLM should earn its cost.
Stage 6 and 7 numbers are in their own docs and in the README.

## 6. Exercises

1. Re-label `evals/judge-labels.jsonl` yourself without looking at the `note` field. How many of my
   labels do you disagree with? Re-run `npm run eval:judge-agreement` with your labels.
2. Add 5 new golden questions about a note you write yourself (put it in `corpus/sample/`), re-ingest,
   and run `npm run eval:retrieval`. Did your new questions pass? Why or why not?
3. Break something on purpose (set `k: 1` in `src/agent/tools.ts` search) and run
   `npm run eval:full -- --gate`. Confirm the gate fails, then revert. This is what CI does on every PR.

## 7. Interview questions

1. **How do you evaluate a RAG system?** Separately: retrieval (recall@k, MRR on a labelled set) and
   generation (correctness, faithfulness, refusal behaviour), end to end on a golden set, plus
   latency and cost. Track them per question type so averages don't hide regressions.
2. **How do you know your LLM judge is any good?** Label a sample by hand and measure agreement and
   kappa; inspect disagreements; version the rubric; re-check when the judge model or rubric changes.
3. **Code-based grading vs LLM judge?** Code checks are free and reproducible but literal; LLM judges
   understand meaning but cost money and drift. Use code checks wherever possible and the judge for
   the rest; combining both catches more errors than either.
4. **How do you put an LLM eval in CI when outputs are non-deterministic?** Gate deterministic parts
   exactly; for LLM parts, compare against a baseline with a tolerance, keep the set small enough to
   run per PR, and rerun or review before blocking on small drops.
5. **Why include unanswerable questions?** Without them, an eval rewards guessing. A system that
   always answers looks great until a user asks something the notes don't cover.
