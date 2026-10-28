export interface Citation {
  id: string;
  path: string;
  headingPath: string;
  chunkId: number;
  snippet: string;
}

export interface Done {
  answer: string;
  citations: Citation[];
  refused: boolean;
  refusalReason?: string;
  drafts: { title: string; path: string; body: string }[];
  route: string;
  model: string;
  costUsd: number;
  latencyMs: number;
  ttftMs: number | null;
  toolCalls: number;
  traceId: string;
}

export type AgentEvent =
  | { type: "route"; route: string; model: string; reason: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; name: string; ok: boolean; ms: number }
  | { type: "text"; delta: string }
  | { type: "verify"; ok: boolean; problems: string[] }
  | { type: "retry"; problems: string[] }
  | ({ type: "done" } & Done)
  | { type: "error"; message: string };

/**
 * POST a question and read the Server-Sent Events stream. (The browser's EventSource only does GET,
 * so we parse the stream ourselves: events are separated by a blank line.)
 */
export async function ask(question: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event && data) onEvent({ ...JSON.parse(data), type: event } as AgentEvent);
    }
  }
}

export async function fetchNote(path: string): Promise<{ path: string; title: string; markdown: string }> {
  const res = await fetch(`/api/notes?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Note not found");
  return res.json();
}

export async function fetchHealth(): Promise<{ provider: string; answerModel: string; routerModel: string; embedder: string; docs: number; chunks: number }> {
  const res = await fetch("/api/health");
  return res.json();
}
