import { useEffect, useRef, useState } from "react";
import { ask, fetchHealth, fetchNote, type AgentEvent, type Citation, type Done } from "./api";
import { Markdown } from "./Markdown";

interface Turn {
  id: number;
  question: string;
  steps: string[];
  streaming: string;
  result?: Done;
  error?: string;
}

const EXAMPLES = [
  "When is the on-call handoff?",
  "Why did the Harbor cutover slip, and what fixed it?",
  "Is Project Kestrel cancelled?",
  "What is the Wi-Fi password for the Portland office?",
  "Draft a short page summarizing Project Harbor for the engineering all-hands.",
];

export function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ title: string; path: string; markdown: string; highlight?: string } | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchHealth>> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const update = (id: number, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));

  async function submit(question: string) {
    if (!question.trim() || busy) return;
    const id = Date.now();
    setTurns((ts) => [...ts, { id, question, steps: [], streaming: "" }]);
    setInput("");
    setBusy(true);
    try {
      await ask(question, (e: AgentEvent) => {
        if (e.type === "route") update(id, (t) => ({ ...t, steps: [...t.steps, `Routed to ${e.model} (${e.route}: ${e.reason})`] }));
        // Text streamed before a tool call is the model thinking aloud; drop it once it acts.
        else if (e.type === "tool_start") update(id, (t) => ({ ...t, streaming: "", steps: [...t.steps, `${e.name}(${describe(e.input)})`] }));
        else if (e.type === "text") update(id, (t) => ({ ...t, streaming: t.streaming + e.delta }));
        else if (e.type === "verify") update(id, (t) => ({ ...t, steps: [...t.steps, e.ok ? "Citations verified" : `Citation check failed: ${e.problems.length} problem(s)`] }));
        else if (e.type === "retry") update(id, (t) => ({ ...t, streaming: "", steps: [...t.steps, "Rewriting the answer once"] }));
        else if (e.type === "done") update(id, (t) => ({ ...t, result: e }));
        else if (e.type === "error") update(id, (t) => ({ ...t, error: e.message }));
      });
    } catch (err) {
      update(id, (t) => ({ ...t, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function openCitation(c: Citation) {
    try {
      const n = await fetchNote(c.path);
      setNote({ ...n, highlight: c.snippet.replace(/^…/, "").slice(0, 60) });
    } catch {
      setNote({ title: c.path, path: c.path, markdown: c.snippet });
    }
  }

  return (
    <div className="layout">
      <main className="chat">
        <header>
          <h1>Ask My Notes</h1>
          {health && (
            <span className="meta">
              {health.docs} notes · {health.chunks} chunks · {health.provider === "offline" ? "offline baseline (no Claude)" : `${health.answerModel} / ${health.routerModel}`}
            </span>
          )}
        </header>

        {turns.length === 0 && (
          <div className="empty">
            <p>Ask anything about your notes. Every answer cites its sources.</p>
            {EXAMPLES.map((q) => (
              <button key={q} className="example" onClick={() => submit(q)}>
                {q}
              </button>
            ))}
          </div>
        )}

        {turns.map((t) => (
          <section key={t.id} className="turn">
            <div className="question">{t.question}</div>
            <ol className="steps">
              {t.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              {!t.result && !t.error && <li className="pulse">working…</li>}
            </ol>
            {t.error && <div className="error">Error: {t.error}</div>}
            {!t.result && t.streaming && (
              <div className="answer streaming">
                <Markdown text={t.streaming} />
              </div>
            )}
            {t.result && <Answer r={t.result} onOpen={openCitation} />}
          </section>
        ))}
        <div ref={bottom} />

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question about your notes…" disabled={busy} autoFocus />
          <button disabled={busy || !input.trim()}>{busy ? "…" : "Ask"}</button>
        </form>
      </main>

      {note && (
        <aside className="drawer">
          <div className="drawer-head">
            <div>
              <strong>{note.title}</strong>
              <div className="meta">{note.path}</div>
            </div>
            <button onClick={() => setNote(null)} aria-label="Close">
              ×
            </button>
          </div>
          <pre className="note">{highlight(note.markdown, note.highlight)}</pre>
        </aside>
      )}
    </div>
  );
}

function Answer({ r, onOpen }: { r: Done; onOpen: (c: Citation) => void }) {
  const byId = new Map(r.citations.map((c) => [c.id, c]));
  return (
    <div className={`answer ${r.refused ? "refused" : ""}`}>
      <Markdown text={r.answer} known={new Set(byId.keys())} onCite={(id) => byId.get(id) && onOpen(byId.get(id)!)} />
      {r.drafts.map((d) => (
        <details key={d.path} className="draft" open>
          <summary>Draft saved for review: {d.title}</summary>
          <Markdown text={d.body} />
          <div className="meta">{d.path}</div>
        </details>
      ))}
      {r.citations.length > 0 && (
        <div className="sources">
          {r.citations.map((c) => (
            <button key={c.id} className="source" onClick={() => onOpen(c)}>
              <span className="cite">{c.id.slice(1)}</span>
              <span>
                <strong>{c.path}</strong>
                <span className="meta"> · {c.headingPath.split(" > ").slice(1).join(" > ") || c.headingPath}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="meta footer">
        {r.refused && <span className="badge">refused: {r.refusalReason?.replace(/_/g, " ")}</span>}
        {r.route} → {r.model} · {r.toolCalls} tool call{r.toolCalls === 1 ? "" : "s"} · {(r.latencyMs / 1000).toFixed(2)} s
        {r.ttftMs !== null ? ` (first token ${(r.ttftMs / 1000).toFixed(2)} s)` : ""} · ${r.costUsd.toFixed(4)} ·{" "}
        <a href={`/api/traces/${r.traceId}`} target="_blank" rel="noreferrer">
          trace
        </a>
      </div>
    </div>
  );
}

function describe(input: Record<string, unknown>): string {
  const v = input.query ?? input.path ?? input.title ?? "";
  return JSON.stringify(String(v).slice(0, 60));
}

function highlight(text: string, needle?: string) {
  if (!needle) return text;
  const i = text.indexOf(needle.split("\n")[0].trim().slice(0, 40));
  if (i < 0) return text;
  const end = i + needle.length;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, end)}</mark>
      {text.slice(end)}
    </>
  );
}
