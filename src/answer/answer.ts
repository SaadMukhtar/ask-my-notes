import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { config } from "../config";
import { getLLM, textOf, type LLM } from "../llm/client";
import { costUsd, fromApiUsage } from "../llm/pricing";
import { search } from "../retrieve/search";
import type { Hit } from "../retrieve/types";
import { saveTrace, TraceRecorder, type Trace } from "../trace";
import { citedIds } from "./citations";
import { buildUserMessage, REFUSAL, SYSTEM_PROMPT } from "./prompt";

export interface Citation {
  id: string;
  path: string;
  headingPath: string;
  chunkId: number;
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  refused: boolean;
  trace: Trace;
}

export interface AnswerOptions {
  k?: number;
  model?: string;
  llm?: LLM;
  onText?: (delta: string) => void;
  saveTrace?: boolean;
}

/**
 * Stage 3: one-shot RAG. Retrieve top-k chunks, put them in the prompt as numbered sources,
 * stream Claude's answer, and map [S#] markers back to chunks. (Stage 4's agent builds on this.)
 */
export async function answerQuestion(pool: pg.Pool, question: string, opts: AnswerOptions = {}): Promise<AnswerResult> {
  const llm = opts.llm ?? getLLM();
  const model = llm.provider === "offline" ? "offline-extractive" : (opts.model ?? config.answerModel);
  const rec = new TraceRecorder("answer", question);

  const hits = await rec.step("retrieve", "search", { question, k: opts.k ?? 6 }, async () =>
    (await search(pool, question, { k: opts.k ?? 6 })).hits,
    (h) => ({ output: h.map((x) => ({ chunkId: x.chunkId, path: x.path, headingPath: x.headingPath })) }),
  );

  const params: Anthropic.MessageStreamParams = {
    model,
    max_tokens: 4000,
    // A cache breakpoint on the system prompt: the first call writes it to the cache, later calls
    // within 5 minutes read it at ~10% of the input price. Verify with usage.cache_read_input_tokens.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    // Medium effort: question answering over provided sources rarely needs deep reasoning.
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: buildUserMessage(question, hits) }],
  };

  const msg = await rec.step("llm", "answer", { model, sources: hits.length }, () => llm.stream(params, { onText: opts.onText, timeoutMs: 60_000 }), (m) => {
    const usage = fromApiUsage(m.usage);
    return { model, usage, costUsd: costUsd(model, usage), output: { stop_reason: m.stop_reason } };
  });

  const answer = msg.stop_reason === "refusal" ? REFUSAL : textOf(msg).trim();
  const refused = answer.startsWith(REFUSAL) || hits.length === 0;
  const citations = resolveCitations(answer, hits);
  const trace = rec.finish({ status: refused ? "refused" : "answered", answer, citations, model });
  if (opts.saveTrace !== false) await saveTrace(pool, trace);
  return { answer, citations, refused, trace };
}

/** Map [S#] markers to the chunks they point at. Markers that point nowhere are dropped (and caught by stage 6). */
export function resolveCitations(answer: string, sources: Hit[]): Citation[] {
  return citedIds(answer)
    .map((id) => {
      const h = sources[Number(id.slice(1)) - 1];
      return h && { id, path: h.path, headingPath: h.headingPath, chunkId: h.chunkId, snippet: h.content.slice(0, 280) };
    })
    .filter((c): c is Citation => Boolean(c));
}
