import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { OfflineLLM } from "./offline";

export interface StreamOptions {
  /** Called with each text delta as it arrives (what the UI renders token by token). */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  /** Per-request timeout in ms (the SDK default is 10 minutes, far too long for a chat app). */
  timeoutMs?: number;
}

/**
 * The one interface the rest of the app uses to talk to a model. Two implementations:
 * - AnthropicLLM: the real Claude API via the official SDK.
 * - OfflineLLM: a deterministic extractive stand-in (no network). It exists so the pipeline,
 *   tests, CI, and the UI work without an API key. It is NOT Claude, and any number measured
 *   with it is labelled "offline baseline".
 */
export interface LLM {
  readonly provider: "anthropic" | "offline";
  stream(params: Anthropic.MessageStreamParams, opts?: StreamOptions): Promise<Anthropic.Message>;
}

export class AnthropicLLM implements LLM {
  readonly provider = "anthropic" as const;
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // The SDK reads ANTHROPIC_API_KEY itself. maxRetries 2 covers 429 / 5xx / connection errors.
    this.client = client ?? new Anthropic({ maxRetries: 2 });
  }

  async stream(params: Anthropic.MessageStreamParams, opts: StreamOptions = {}): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(params, { signal: opts.signal, timeout: opts.timeoutMs });
    if (opts.onText) stream.on("text", (delta) => opts.onText!(delta));
    return stream.finalMessage();
  }
}

let cached: LLM | undefined;

export function getLLM(): LLM {
  if (cached) return cached;
  if (config.llmProvider === "offline") cached = new OfflineLLM();
  else {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env, or set LLM_PROVIDER=offline to run the extractive baseline without Claude.",
      );
    }
    cached = new AnthropicLLM();
  }
  return cached;
}

/** For tests: inject a fake. */
export function setLLM(llm: LLM | undefined): void {
  cached = llm;
}

/** Concatenate the text blocks of a response (thinking and tool_use blocks are skipped). */
export function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
