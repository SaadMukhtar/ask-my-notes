import type Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { resolveCitations, type Citation } from "../answer/answer";
import { REFUSAL } from "../answer/prompt";
import { config } from "../config";
import { structuralVerifier } from "../guardrails/structural";
import type { Verifier, VerifyResult } from "../guardrails/types";
import { getLLM, textOf, type LLM } from "../llm/client";
import { costUsd, fromApiUsage, totalTokens } from "../llm/pricing";
import { saveTrace, TraceRecorder, type Trace } from "../trace";
import { AGENT_SYSTEM_PROMPT, MAX_TOOL_STEPS, retryMessage } from "./prompt";
import { heuristicRoute, llmRoute, type RouteDecision } from "./router";
import { SourceRegistry } from "./sources";
import { runTool, TOOL_DEFS, withTimeout, type ToolContext } from "./tools";

export interface AgentOptions {
  llm?: LLM;
  verifier?: Verifier;
  /** "llm" asks the small model to classify the question; "heuristic" uses rules; or force a route. */
  router?: "llm" | "heuristic" | "easy" | "hard";
  maxToolSteps?: number;
  /** Hard cap on tokens (input + output + cache) across all model calls for one question. */
  tokenBudget?: number;
  toolTimeoutMs?: number;
  llmTimeoutMs?: number;
  draftsDir?: string;
  saveTrace?: boolean;
  /** Live progress for the UI: route decisions, tool calls, text deltas. */
  onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "route"; route: string; model: string; reason: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_end"; name: string; ok: boolean; ms: number }
  | { type: "text"; delta: string }
  | { type: "verify"; ok: boolean; problems: string[] }
  | { type: "retry"; problems: string[] };

export interface AgentResult {
  answer: string;
  citations: Citation[];
  refused: boolean;
  refusalReason?: "no_evidence" | "max_steps" | "token_budget" | "verification_failed" | "model_refusal" | "error";
  route: RouteDecision;
  drafts: ToolContext["drafts"];
  verification?: VerifyResult;
  trace: Trace;
}

const MODEL_FOR = { easy: () => config.routerModel, hard: () => config.answerModel };

/**
 * The agent loop from the README diagram:
 *
 *   route ─► plan (model call) ─► tool? ─► observe ─► enough evidence? ─► draft answer ─► verify ─► done
 *              ▲                     │                      │ no, steps left       │ fail: retry once
 *              └─────────────────────┘◄─────────────────────┘                      └─► still failing: refuse
 *
 * "Enough evidence?" is the model's call (it stops requesting tools), bounded by three hard stops
 * that are code, not prompt: max tool steps, a token budget, and per-call timeouts.
 */
export async function runAgent(pool: pg.Pool, question: string, opts: AgentOptions = {}): Promise<AgentResult> {
  const llm = opts.llm ?? getLLM();
  const verifier = opts.verifier ?? structuralVerifier;
  const maxSteps = opts.maxToolSteps ?? MAX_TOOL_STEPS;
  const budget = opts.tokenBudget ?? Number(process.env.TOKEN_BUDGET ?? 60_000);
  const toolTimeout = opts.toolTimeoutMs ?? 5_000;
  const llmTimeout = opts.llmTimeoutMs ?? 60_000;
  const emit = opts.onEvent ?? (() => {});
  const rec = new TraceRecorder("agent", question);
  const registry = new SourceRegistry();
  const ctx: ToolContext = { pool, registry, draftsDir: opts.draftsDir ?? "./data/drafts", drafts: [] };

  // ── 1. Route ────────────────────────────────────────────────────────────────────────────────
  const routerKind = opts.router ?? (llm.provider === "offline" ? "heuristic" : (process.env.ROUTER as AgentOptions["router"]) ?? "llm");
  const decision = await rec.step("route", routerKind, { question }, async (): Promise<RouteDecision> => {
    if (routerKind === "easy" || routerKind === "hard") return { route: routerKind, by: "heuristic", reason: "forced" };
    if (routerKind === "llm") return llmRoute(llm, config.routerModel, question);
    return heuristicRoute(question);
  }, (d) => ({ output: d, usage: d.usage, costUsd: d.costUsd, model: d.model }));
  const model = llm.provider === "offline" ? "offline-extractive" : MODEL_FOR[decision.route]();
  emit({ type: "route", route: decision.route, model, reason: decision.reason });

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Question: ${question}` }];
  let toolSteps = 0;

  const finish = async (answer: string, refusalReason?: AgentResult["refusalReason"], verification?: VerifyResult): Promise<AgentResult> => {
    const refused = Boolean(refusalReason) || answer.startsWith(REFUSAL);
    const reason = refusalReason ?? (refused ? "no_evidence" : undefined);
    if (refused && !answer.startsWith(REFUSAL)) answer = `${REFUSAL}\n${answer}`.trim();
    if (reason && reason !== "no_evidence") rec.add({ type: "refuse", name: reason, startedAt: Date.now(), ms: 0 });
    const citations = refused ? [] : resolveCitations(answer, registry.sources);
    const trace = rec.finish({ status: refused ? "refused" : "answered", answer, citations, route: decision.route, model });
    if (opts.saveTrace !== false) await saveTrace(pool, trace);
    return { answer, citations, refused, refusalReason: reason, route: decision, drafts: ctx.drafts, verification, trace };
  };

  /** One model call with budget accounting. Returns null when the budget is already spent. */
  const callModel = async (name: string, extra: Partial<Anthropic.MessageStreamParams> = {}) => {
    const used = totalTokens(rec.usage);
    if (used >= budget) return null;
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: Math.max(256, Math.min(4000, budget - used)),
      system: AGENT_SYSTEM_PROMPT,
      tools: TOOL_DEFS,
      // Automatic caching: the API places a breakpoint on the last cacheable block, so every step
      // re-reads tools + system + all earlier steps from cache instead of paying full price again.
      cache_control: { type: "ephemeral" },
      output_config: { effort: decision.route === "easy" ? "low" : "medium" },
      messages,
      ...extra,
    };
    return rec.step("llm", name, { model, step: toolSteps }, () =>
      llm.stream(params, { timeoutMs: llmTimeout, onText: (delta) => emit({ type: "text", delta }) }),
      (m) => {
        const usage = fromApiUsage(m.usage);
        return { model, usage, costUsd: costUsd(model, usage), output: { stop_reason: m.stop_reason, content: m.content } };
      },
    );
  };

  try {
    // ── 2. Plan → act → observe, until the model stops asking for tools ────────────────────────
    let draft: string | null = null;
    while (draft === null) {
      const msg = await callModel(`plan#${toolSteps}`);
      if (!msg) return finish("", "token_budget");
      if (msg.stop_reason === "refusal") return finish("", "model_refusal");
      messages.push({ role: "assistant", content: msg.content });

      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || uses.length === 0) {
        draft = textOf(msg).trim();
        break;
      }
      if (toolSteps >= maxSteps) return finish("", "max_steps");

      // Run this turn's tool calls in parallel, within the step allowance. All results go back in
      // ONE user message (splitting them teaches the model to stop calling tools in parallel).
      const allowed = uses.slice(0, maxSteps - toolSteps);
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
          if (!allowed.includes(u)) return { type: "tool_result", tool_use_id: u.id, is_error: true, content: "Tool step limit reached. Answer with the evidence you have, or refuse." };
          emit({ type: "tool_start", name: u.name, input: u.input });
          const t0 = performance.now();
          try {
            const out = await rec.step("tool", u.name, u.input, () => withTimeout(runTool(u.name, u.input, ctx), toolTimeout, u.name), (o) => ({ output: o.summary }));
            emit({ type: "tool_end", name: u.name, ok: true, ms: performance.now() - t0 });
            return { type: "tool_result", tool_use_id: u.id, content: out.content };
          } catch (err) {
            emit({ type: "tool_end", name: u.name, ok: false, ms: performance.now() - t0 });
            // Errors go back to the model as data so it can recover (e.g. fix a wrong path).
            return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Error: ${(err as Error).message}` };
          }
        }),
      );
      toolSteps += allowed.length;
      messages.push({ role: "user", content: results });
    }

    // ── 3. Verify citations; one retry; then refuse ─────────────────────────────────────────────
    if (draft.startsWith(REFUSAL)) return finish(draft);
    let verification = await rec.step("verify", "citations", { answer: draft }, () => verifier(draft!, registry), (v) => ({ output: { ok: v.ok, problems: v.problems, checks: v.checks }, usage: v.usage, costUsd: v.costUsd }));
    emit({ type: "verify", ok: verification.ok, problems: verification.problems });
    if (!verification.ok) {
      emit({ type: "retry", problems: verification.problems });
      messages.push({ role: "user", content: retryMessage(verification.problems) });
      const msg = await callModel("rewrite", { tool_choice: { type: "none" } });
      if (!msg) return finish("", "token_budget", verification);
      messages.push({ role: "assistant", content: msg.content });
      draft = textOf(msg).trim();
      if (draft.startsWith(REFUSAL)) return finish(draft, undefined, verification);
      verification = await rec.step("verify", "citations-retry", { answer: draft }, () => verifier(draft!, registry), (v) => ({ output: { ok: v.ok, problems: v.problems, checks: v.checks }, usage: v.usage, costUsd: v.costUsd }));
      emit({ type: "verify", ok: verification.ok, problems: verification.problems });
      if (!verification.ok) return finish("", "verification_failed", verification);
    }
    return finish(draft, undefined, verification);
  } catch (err) {
    rec.add({ type: "error", name: "agent", startedAt: Date.now(), ms: 0, error: (err as Error).message });
    const res = await finish("", "error");
    return res;
  }
}
