import type Anthropic from "@anthropic-ai/sdk";
import type { LLM, StreamOptions } from "../src/llm/client";

/**
 * A scripted fake model: returns the queued responses in order and records every request.
 * Tests use it to check what we *send* to Claude (prompt, caching, tools) and how we handle
 * what comes back, without any network calls.
 */
export class FakeLLM implements LLM {
  readonly provider = "anthropic" as const;
  readonly requests: Anthropic.MessageStreamParams[] = [];
  constructor(private readonly script: Array<Anthropic.ContentBlock | Anthropic.ContentBlock[] | ((p: Anthropic.MessageStreamParams) => Anthropic.ContentBlock[])>) {}

  async stream(params: Anthropic.MessageStreamParams, opts: StreamOptions = {}): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error("FakeLLM: script exhausted");
    const out = typeof next === "function" ? next(params) : next;
    const content = Array.isArray(out) ? out : [out];
    for (const b of content) if (b.type === "text" && opts.onText) for (const w of b.text.split(/(?<= )/)) opts.onText(w);
    return {
      id: `msg_fake_${this.requests.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
    } as unknown as Anthropic.Message;
  }
}

export const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;
export const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;
