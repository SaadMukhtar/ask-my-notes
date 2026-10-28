import type Anthropic from "@anthropic-ai/sdk";
import { REFUSAL } from "../answer/prompt";
import { contentTerms } from "../embed/text";
import type { LLM, StreamOptions } from "./client";

/**
 * OfflineLLM: a deterministic, extractive stand-in for Claude. No network, no key, no cost.
 *
 * It speaks the same Messages API shape as the real model, so the answer pipeline and the agent
 * loop run unchanged. It "answers" by picking the source sentences that best overlap the question
 * and citing them; as an "agent" it follows a fixed plan (search, maybe read_page, maybe
 * draft_page, then answer).
 *
 * It is a *baseline*, not a model: useful for tests, CI without secrets, demos, and as the floor
 * any LLM should beat in the evals. Never report its numbers as Claude's.
 */
export class OfflineLLM implements LLM {
  readonly provider = "offline" as const;
  private n = 0;

  async stream(params: Anthropic.MessageStreamParams, opts: StreamOptions = {}): Promise<Anthropic.Message> {
    const toolNames = new Set((params.tools ?? []).map((t) => ("name" in t ? t.name : "")));
    const question = findQuestion(params.messages);
    const sources = collectSources(params.messages);
    const calls = toolCallsSoFar(params.messages);

    let content: Anthropic.ContentBlock[];
    let stop: Anthropic.StopReason = "end_turn";
    const isDraft = /\b(draft|write (?:a|an|up)|create a page)\b/i.test(question);
    const isSummary = /\bsummar/i.test(question);

    if (toolNames.has("search") && calls.length === 0) {
      content = [toolUse(`toolu_off_${this.n}_1`, "search", { query: question })];
      stop = "tool_use";
    } else if (toolNames.has("read_page") && isSummary && !calls.includes("read_page") && sources.length) {
      content = [toolUse(`toolu_off_${this.n}_2`, "read_page", { path: sources[0].path })];
      stop = "tool_use";
    } else if (toolNames.has("draft_page") && isDraft && !calls.includes("draft_page") && sources.length) {
      const body = extractiveAnswer(question, sources, 6);
      content = [toolUse(`toolu_off_${this.n}_3`, "draft_page", { title: draftTitle(question), body })];
      stop = "tool_use";
    } else {
      const text = isDraft && calls.includes("draft_page")
        ? `I drafted the page "${draftTitle(question)}". Summary of what it covers:\n\n${extractiveAnswer(question, sources, 4)}`
        : extractiveAnswer(question, sources, 3);
      if (opts.onText) for (const piece of text.match(/\S+\s*/g) ?? []) opts.onText(piece);
      content = [{ type: "text", text, citations: null } as Anthropic.TextBlock];
    }

    this.n++;
    const inputChars = JSON.stringify(params.messages).length + JSON.stringify(params.system ?? "").length;
    const outputChars = JSON.stringify(content).length;
    return {
      id: `msg_offline_${this.n}`,
      type: "message",
      role: "assistant",
      model: "offline-extractive",
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: Math.ceil(inputChars / 4),
        output_tokens: Math.ceil(outputChars / 4),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown as Anthropic.Message;
  }
}

export interface ParsedSource {
  id: string;
  path: string;
  section: string;
  content: string;
}

const SOURCE_RE = /<source id="(S\d+)" path="([^"]*)" section="([^"]*)"(?: flagged="[^"]*")?>\n([\s\S]*?)\n<\/source>/g;

export function parseSources(text: string): ParsedSource[] {
  return [...text.matchAll(SOURCE_RE)].map((m) => ({ id: m[1], path: m[2], section: m[3], content: m[4] }));
}

function allText(messages: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") out.push(m.content);
    else
      for (const b of m.content) {
        if (b.type === "text") out.push(b.text);
        if (b.type === "tool_result") {
          if (typeof b.content === "string") out.push(b.content);
          else for (const c of b.content ?? []) if (c.type === "text") out.push(c.text);
        }
      }
  }
  return out;
}

function findQuestion(messages: Anthropic.MessageParam[]): string {
  const first = allText(messages.slice(0, 1)).join("\n");
  const m = /Question:\s*([^\n]+)/.exec(first);
  return (m ? m[1] : first).trim();
}

function collectSources(messages: Anthropic.MessageParam[]): ParsedSource[] {
  const seen = new Map<string, ParsedSource>();
  for (const t of allText(messages)) for (const s of parseSources(t)) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()];
}

function toolCallsSoFar(messages: Anthropic.MessageParam[]): string[] {
  return messages.flatMap((m) =>
    m.role === "assistant" && typeof m.content !== "string"
      ? m.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlockParam).name)
      : [],
  );
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

function draftTitle(question: string): string {
  const m = /(?:summari[sz]ing|about|for|on)\s+(.+?)(?:\s+for\s+.+)?[.?]?$/i.exec(question);
  return (m ? m[1] : "Draft").replace(/^(a|an|the)\s+/i, "").replace(/^\w/, (c) => c.toUpperCase());
}

/** Turn markdown lines into plain candidate sentences (tables become "a: b, c"). */
function sentencesOf(content: string): string[] {
  const out: string[] = [];
  // Notes are hard-wrapped; re-join continuation lines so a sentence is not cut at the wrap.
  const unwrapped = content.replace(/\n(?!\s*(?:[-*+]\s|\d+\.\s|\||#|>|\[|\n))[ \t]*/g, " ");
  for (let line of unwrapped.split("\n")) {
    line = line.trim().replace(/^…/, "");
    if (!line || /^#/.test(line) || /^\|?\s*-{3,}/.test(line) || /^>/.test(line)) continue;
    if (line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) out.push(`${cells[0]}: ${cells.slice(1).join(", ")}`);
      continue;
    }
    line = line.replace(/^(?:[-*+]|\d+\.)\s+/, "").replace(/\*\*/g, "").replace(/`/g, "");
    out.push(...line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/));
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 15 && !s.includes("[removed by Ask My Notes"));
}

/**
 * Pick the source sentences that cover the most (IDF-weighted) question terms, and cite each.
 * Refuse when nothing covers at least a third of the question. This threshold is the offline
 * baseline's entire "judgement" about evidence; Claude does far better.
 */
export function extractiveAnswer(question: string, sources: ParsedSource[], maxSentences: number): string {
  const q = [...new Set(contentTerms(question))].filter((t) => !["draft", "page", "short", "summar", "summarize"].includes(t));
  const cands = sources.flatMap((s) => sentencesOf(s.content).map((text) => ({ text, id: s.id, terms: new Set(contentTerms(text)) })));
  if (!q.length || !cands.length) return REFUSAL;
  const idf = new Map(q.map((t) => [t, Math.log(1 + cands.length / (1 + cands.filter((c) => c.terms.has(t)).length))]));
  const total = [...idf.values()].reduce((a, b) => a + b, 0);
  const scored = cands
    .map((c, i) => ({ ...c, i, score: q.reduce((s, t) => s + (c.terms.has(t) ? idf.get(t)! : 0), 0) / total }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = scored.filter((c) => c.score >= 0.34).slice(0, maxSentences);
  if (!picked.length) return REFUSAL;
  const seen = new Set<string>();
  return picked
    .filter((c) => !seen.has(c.text) && seen.add(c.text))
    .map((c) => `- ${c.text.replace(/[.:;,]?$/, "")} [${c.id}].`)
    .join("\n");
}
