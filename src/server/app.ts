import express from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { runAgent, type AgentOptions } from "../agent/agent";
import { config } from "../config";
import { getLLM } from "../llm/client";

/**
 * HTTP API for the UI.
 *   POST /api/ask         {question} -> Server-Sent Events: route, tool_start, tool_end, text, verify, retry, done
 *   GET  /api/notes?path= -> the raw markdown of a note (only paths that are in the index)
 *   GET  /api/traces/:id  -> a stored trace
 *   GET  /api/health      -> config summary
 * In production the built UI (web/dist) is served from the same origin, so no CORS is needed.
 */
export function createApp(pool: pg.Pool, agentOpts: AgentOptions = {}, basicAuth = process.env.BASIC_AUTH) {
  const app = express();
  // Your notes are private. If the server is reachable by anyone else, set BASIC_AUTH=user:password
  // (and serve it over HTTPS) so every request, UI included, needs credentials.
  if (basicAuth) app.use(requireBasicAuth(basicAuth));
  app.use(express.json({ limit: "20kb" }));

  app.get("/api/health", async (_req, res) => {
    const { rows } = await pool.query("SELECT count(*)::int AS docs, (SELECT count(*)::int FROM chunks) AS chunks FROM documents");
    let provider = config.llmProvider as string;
    try {
      provider = getLLM().provider;
    } catch {
      provider = "anthropic (no API key set)";
    }
    res.json({ ok: true, provider, answerModel: config.answerModel, routerModel: config.routerModel, embedder: config.embedder, ...rows[0] });
  });

  app.post("/api/ask", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question || question.length > 1000) {
      res.status(422).json({ error: { code: "invalid_question", message: "question must be 1-1000 characters" } });
      return;
    }
    // Server-Sent Events: one long-lived HTTP response, one "event: x\ndata: {...}\n\n" per update.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let closed = false;
    res.on("close", () => (closed = true));
    try {
      const out = await runAgent(pool, question, { ...agentOpts, onEvent: (e) => !closed && send(e.type, e) });
      send("done", {
        answer: out.answer,
        citations: out.citations,
        refused: out.refused,
        refusalReason: out.refusalReason,
        drafts: out.drafts.map((d) => ({ title: d.title, path: d.path, body: d.body })),
        route: out.route.route,
        model: out.trace.model,
        costUsd: out.trace.costUsd,
        latencyMs: out.trace.latencyMs,
        ttftMs: out.trace.ttftMs,
        toolCalls: out.trace.steps.filter((s) => s.type === "tool").length,
        traceId: out.trace.id,
      });
    } catch (err) {
      send("error", { message: (err as Error).message });
    }
    res.end();
  });

  app.get("/api/notes", async (req, res) => {
    const rel = String(req.query.path ?? "");
    // Only serve files that are in the index, and only from inside NOTES_DIR (no ../ tricks).
    const { rows } = await pool.query("SELECT title FROM documents WHERE path = $1", [rel]);
    const root = path.resolve(config.notesDir);
    const abs = path.resolve(root, rel);
    if (!rows.length || !abs.startsWith(root + path.sep)) {
      res.status(404).json({ error: { code: "not_found", message: "no such note" } });
      return;
    }
    res.json({ path: rel, title: rows[0].title, markdown: await readFile(abs, "utf8") });
  });

  app.get("/api/traces/:id", async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) {
      res.status(422).json({ error: { code: "invalid_id", message: "trace id must be a UUID" } });
      return;
    }
    const { rows } = await pool.query("SELECT * FROM traces WHERE id = $1", [req.params.id]);
    if (!rows.length) res.status(404).json({ error: { code: "not_found", message: "no such trace" } });
    else res.json(rows[0]);
  });

  const dist = path.resolve("web/dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }
  return app;
}

function requireBasicAuth(expected: string): express.RequestHandler {
  const want = Buffer.from(`Basic ${Buffer.from(expected).toString("base64")}`);
  return (req, res, next) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    // Constant-time comparison so response timing doesn't leak how much of the password matched.
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="Ask My Notes"');
    res.status(401).end();
  };
}
