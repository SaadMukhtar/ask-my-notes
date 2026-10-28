# Stage 7: Latency and cost

> Send easy questions to the small, cheap model; log latency (p50, p95, time to first token) and
> cost for every question; and know where the time and money go.

## 1. What this stage does

```
question ─► router ─► easy (64% of the golden set) ─► claude-haiku-5-5   $0.10 / $0.50 per M tokens
                   └► hard (36%)                    ─► claude-sonnet-5-5  $2.00 / $10.00 per M tokens
every run ─► trace row: latency_ms, ttft_ms, usage {input, output, cacheWrite, cacheRead}, cost_usd
          ─► npm run report:latency   (p50/p95, TTFT, $/question by route, time by step type)
```

Tiny example: "When is the on-call handoff?" is a one-fact lookup. Haiku answers it as well as
Sonnet would, at ~1/20 of the price. "Why did we build Kestrel instead of buying ForecastIQ?" needs
two facts weighed against each other and goes to Sonnet.

## 2. Concepts

**p50 / p95 latency.** Sort all request times; p50 is the middle one (typical), p95 is the one 95% of
requests beat (the slow tail). Users remember the tail, so SLOs are written on p95 or p99.
*Analogy:* "my commute is usually 20 minutes (p50), but one day in twenty it is 45 (p95)."

**Time to first token (TTFT).** With streaming, perceived speed is when text starts appearing, not when
it ends. Agents have a long TTFT because the answer only starts after the tool calls.

**Cost per question.** Sum over all model calls of tokens × price. In an agent the input side grows with
every step (the whole conversation is re-sent), which is why caching matters most there.

**Model routing / cascading.** A cheap classifier decides which model handles each request.
The two error types cost differently: hard→small hurts quality; easy→big only costs money.

**Cache-read share.** The fraction of input tokens served from the prompt cache. The higher it is, the
cheaper and faster each extra agent step gets.

**Where the time goes.** Trace steps are typed (`route`, `retrieve`, `llm`, `tool`, `verify`), so
`report:latency` can say "retrieval is 5 ms; the model is 95% of the time".

## 3. Code walkthrough (read in this order)

1. `src/llm/pricing.ts`: prices and `costUsd()` (from stage 3).
2. `src/agent/router.ts` (stage 4) and `evals/run-router.ts`: router accuracy vs the golden set's
   difficulty labels, and how often each kind of misroute happens.
3. `src/trace.ts`: `markFirstToken()` and the `ttftMs` field; `src/db/schema.sql`: the `ttft_ms` column.
4. `src/eval/full.ts`: `summarise()` now reports TTFT p50/p95, tokens per question, cache-read share, and
   per-route p95 and cost.
5. `evals/report-latency.ts`: the report over real traces (`npm run report:latency`).
6. `evals/estimate-cost.ts`: a clearly labelled *estimate* of Claude's cost per question, projected
   from measured prompt sizes in offline traces.

## 4. Decisions

- Route with Haiku when a key exists, heuristic fallback (D-014); heuristic accuracy measured here.
- Measure latency sequentially with a warm-up, report nearest-rank p95 and TTFT (D-023).
- Report the cost estimate separately from measurements, with its assumptions (D-024).

## 5. Run it and the real numbers

```bash
npm run eval:router
LLM_PROVIDER=offline npm run eval:full -- --no-judge
npm run report:latency -- --hours 1
npm run estimate:cost
```

Measured 2026-10-28:

| What | Result | Measured? |
|---|---|---|
| Heuristic router accuracy vs difficulty labels | **86.0%** (43/50); 4/19 hard → small model, 3/31 easy → big model | yes |
| Share of golden questions routed to Haiku | 64% | yes |
| LLM (Haiku) router accuracy | not measured | needs a key |
| Pipeline overhead without the model (retrieval + tools + verify), offline run | **p50 4 ms, p95 11 ms per question** | yes (offline baseline) |
| Mean tool (retrieval) time per question | 5.5 ms (p95 8.1 ms) | yes |
| End-to-end p95 latency and $/question with Claude | not measured | needs a key |
| Claude $/question, routed + cached | **~$0.0044 (estimate)**: hard/Sonnet ~$0.011, easy/Haiku ~$0.0005 | estimate |
| Claude $/question, all Sonnet, no caching | **~$0.012 (estimate)** | estimate |

Read the router misses: the 4 hard questions sent to the small model are all *traps* (prompt-injection
probes and unanswerable questions) that look like simple lookups: "Is Project Kestrel cancelled?",
"Which vendor won the weather feed contract renewal?". A router that only looks at the question cannot
see that the evidence is tricky. That is an argument for the verifier running on every route.

## 6. Exercises

1. With a key, run `npm run eval:full` twice: once as is, once with `ROUTER=hard` (everything on Sonnet).
   Compare pass rate and $/question. Was routing worth it? (Fill in the table above.)
2. Add a rule to `heuristicRoute()` that sends questions starting with "Is ..." or containing "won" /
   "cancel" to `hard`. Re-run `npm run eval:router`. Did accuracy go up, and did you just overfit to 50
   questions? How would you check?
3. Run `npm run report:latency` after asking 10 questions in the UI with a key. Which step type dominates
   p95? What would you change first to cut p95 by half?

## 7. Interview questions

1. **Why p95 rather than average latency?** Averages hide the tail; a few very slow requests ruin user
   experience and often point to real problems (timeouts, retries, long agent loops).
2. **How do you reduce LLM cost without hurting quality?** Prompt caching, routing easy traffic to a
   smaller model, lower effort where it doesn't help, fewer agent steps, shorter prompts and outputs,
   batching non-interactive work; measure quality per change.
3. **How would you evaluate a model router?** Label a set by difficulty (or by "small model's answer
   passed"), measure accuracy and the two error types separately, and compare end-to-end quality and
   cost with routing vs without.
4. **Why is TTFT high for agents and what can you do?** The answer streams only after the tool calls;
   stream progress events (which tool is running), parallelise tool calls, cache prompts, and route easy
   questions to the faster model.
5. **What would you log per request in production?** Request id, route, model, every step with timing,
   tokens (incl. cache read/write), cost, status (answered/refused/error), and enough input/output to
   replay, with privacy controls on the content.
