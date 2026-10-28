import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db/pool";
import { HashEmbedder } from "../src/embed/hash";
import { ingestDirectory } from "../src/ingest/ingest";
import { OfflineLLM } from "../src/llm/offline";
import { createApp } from "../src/server/app";
import { freshTestDb } from "./helpers";

describe("HTTP API (Postgres)", async () => {
  const pool = await freshTestDb();
  let server: Server;
  let base = "";
  beforeAll(async () => {
    if (!pool) return;
    await ingestDirectory(pool, new HashEmbedder(), "./corpus/sample", { maxTokens: 220, minTokens: 60, overlapTokens: 30 });
    server = createApp(pool, { llm: new OfflineLLM(), saveTrace: true }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.close();
    await closePools();
  });

  it.skipIf(!pool)("GET /api/health reports the index size", async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, docs: 35 });
  });

  it.skipIf(!pool)("POST /api/ask streams route, tool, text, and done events over SSE", async () => {
    const res = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What is the yearly learning budget per engineer?" }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text();
    const events = [...raw.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe("route");
    expect(events).toContain("tool_start");
    expect(events).toContain("text");
    expect(events.at(-1)).toBe("done");
    const done = JSON.parse(/event: done\ndata: (.*)/.exec(raw)![1]);
    expect(done.answer).toContain("1,200");
    expect(done.citations[0].path).toBe("docs/onboarding-guide.md");

    const trace = await (await fetch(`${base}/api/traces/${done.traceId}`)).json();
    expect(trace.question).toBe("What is the yearly learning budget per engineer?");
  });

  it.skipIf(!pool)("rejects empty questions with 422", async () => {
    const res = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "  " }) });
    expect(res.status).toBe(422);
  });

  it.skipIf(!pool)("serves indexed notes but never files outside the index (path traversal)", async () => {
    expect((await fetch(`${base}/api/notes?path=docs/glossary.md`)).status).toBe(200);
    expect((await fetch(`${base}/api/notes?path=../../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/notes?path=/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/api/traces/not-a-uuid`)).status).toBe(422);
  });

  it.skipIf(!pool)("BASIC_AUTH: requires credentials on every route when configured", async () => {
    const locked = createApp(pool!, {}, "me:secret").listen(0);
    const url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}/api/health`;
    const auth = (s: string) => ({ headers: { authorization: `Basic ${Buffer.from(s).toString("base64")}` } });
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, auth("me:wrong"))).status).toBe(401);
      expect((await fetch(url, auth("me:secret"))).status).toBe(200);
    } finally {
      locked.close();
    }
  });
});

