import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { config } from "./config";
import { ZERO_USAGE, addUsage, type TokenUsage } from "./llm/pricing";

/**
 * One step of a run: a model call, a tool call, a guardrail check, or a routing decision.
 * Every step records what went in, what came out, tokens, and time. That is what lets an eval
 * "replay" a run: re-grade the final answer, or inspect where an agent went wrong, without
 * paying for the model calls again.
 */
export interface TraceStep {
  type: "route" | "retrieve" | "llm" | "tool" | "verify" | "refuse" | "error";
  name: string;
  startedAt: number;
  ms: number;
  input?: unknown;
  output?: unknown;
  model?: string;
  usage?: TokenUsage;
  costUsd?: number;
  error?: string;
}

export interface Trace {
  id: string;
  kind: "answer" | "agent";
  question: string;
  route?: "easy" | "hard";
  model?: string;
  status: "answered" | "refused" | "error";
  answer: string;
  citations: unknown[];
  steps: TraceStep[];
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
}

export class TraceRecorder {
  readonly id = randomUUID();
  readonly steps: TraceStep[] = [];
  private readonly t0 = performance.now();
  usage: TokenUsage = { ...ZERO_USAGE };
  costUsd = 0;

  constructor(
    readonly kind: Trace["kind"],
    readonly question: string,
  ) {}

  /** Time an async operation and record it as a step. Errors are recorded, then re-thrown. */
  async step<T>(type: TraceStep["type"], name: string, input: unknown, fn: () => Promise<T>, describe?: (out: T) => Partial<TraceStep>): Promise<T> {
    const startedAt = Date.now();
    const s0 = performance.now();
    try {
      const out = await fn();
      const extra = describe ? describe(out) : { output: out };
      this.add({ type, name, startedAt, ms: performance.now() - s0, input, ...extra });
      return out;
    } catch (err) {
      this.add({ type: "error", name, startedAt, ms: performance.now() - s0, input, error: String((err as Error)?.message ?? err) });
      throw err;
    }
  }

  add(step: TraceStep): void {
    this.steps.push(step);
    if (step.usage) this.usage = addUsage(this.usage, step.usage);
    if (step.costUsd) this.costUsd += step.costUsd;
  }

  elapsedMs(): number {
    return performance.now() - this.t0;
  }

  finish(fields: Pick<Trace, "status" | "answer" | "citations"> & Partial<Pick<Trace, "route" | "model">>): Trace {
    return {
      id: this.id,
      kind: this.kind,
      question: this.question,
      steps: this.steps,
      usage: this.usage,
      costUsd: this.costUsd,
      latencyMs: Math.round(this.elapsedMs()),
      createdAt: new Date().toISOString(),
      ...fields,
    };
  }
}

/** Persist a trace to Postgres and append it to a daily JSONL file. Never let logging break a request. */
export async function saveTrace(pool: pg.Pool | null, trace: Trace): Promise<void> {
  try {
    await mkdir(config.traceDir, { recursive: true });
    await appendFile(path.join(config.traceDir, `${trace.createdAt.slice(0, 10)}.jsonl`), JSON.stringify(trace) + "\n");
  } catch (err) {
    console.warn("[trace] could not write JSONL:", (err as Error).message);
  }
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO traces (id, kind, question, route, model, status, answer, citations, steps, usage, cost_usd, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [trace.id, trace.kind, trace.question, trace.route ?? null, trace.model ?? null, trace.status, trace.answer,
       JSON.stringify(trace.citations), JSON.stringify(trace.steps), JSON.stringify(trace.usage), trace.costUsd, trace.latencyMs],
    );
  } catch (err) {
    console.warn("[trace] could not write to Postgres:", (err as Error).message);
  }
}
