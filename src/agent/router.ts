import type { LLM } from "../llm/client";
import { textOf } from "../llm/client";
import { costUsd, fromApiUsage, type TokenUsage } from "../llm/pricing";

export type Route = "easy" | "hard";

export interface RouteDecision {
  route: Route;
  by: "heuristic" | "llm";
  reason: string;
  usage?: TokenUsage;
  costUsd?: number;
  model?: string;
}

/**
 * Rule-based router: free, instant, and explainable. "Hard" means the question likely needs several
 * facts combined, reasoning about why, a summary, or writing; "easy" means a single fact lookup.
 */
export function heuristicRoute(question: string): RouteDecision {
  const q = question.toLowerCase();
  const rules: [RegExp, string][] = [
    [/\b(draft|write|create)\b/, "asks to write"],
    [/\bsummar|\boverview\b|\brecap\b/, "asks for a summary"],
    [/\bwhy\b|\bexplain\b|\breason/, "asks why"],
    [/\bcompare|\bdifference|\bversus\b|\bvs\.?\b|\btrade-?offs?\b/, "asks to compare"],
    [/\bhow does\b|\bhow did\b|\bwhat changed\b|\bwhat changes\b/, "asks how something works or changed"],
    [/\b(and|also)\b.*\?|\?.+\?/, "asks more than one thing"],
    [/\bwhich\b.*\b(done|complete|already)\b|\ball the\b|\blist (all|every)\b/, "asks to collect several facts"],
    [/\bdecid|\bdecision\b|\bcriteria\b|\boptions?\b/, "asks about a decision"],
  ];
  for (const [re, reason] of rules) if (re.test(q)) return { route: "hard", by: "heuristic", reason };
  if (q.split(/\s+/).length > 18) return { route: "hard", by: "heuristic", reason: "long question" };
  return { route: "easy", by: "heuristic", reason: "single-fact lookup" };
}

const ROUTER_SYSTEM = `You route questions about a team's internal notes to one of two models.
Reply with exactly one word: EASY or HARD.
EASY: one fact that a single passage answers (a date, number, name, setting, definition).
HARD: needs several facts combined, an explanation of why, a summary, a comparison, a decision with its reasons, or writing a document.`;

/** LLM router: asks the small model to classify. Falls back to the heuristic if anything goes wrong. */
export async function llmRoute(llm: LLM, model: string, question: string): Promise<RouteDecision> {
  try {
    const msg = await llm.stream(
      {
        model,
        max_tokens: 16,
        // Classification needs no reasoning; thinking off keeps it fast and cheap.
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: ROUTER_SYSTEM,
        messages: [{ role: "user", content: question }],
      },
      { timeoutMs: 10_000 },
    );
    const word = textOf(msg).trim().toUpperCase();
    const usage = fromApiUsage(msg.usage);
    if (word.startsWith("EASY") || word.startsWith("HARD")) {
      return { route: word.startsWith("EASY") ? "easy" : "hard", by: "llm", reason: `${model} said ${word}`, usage, costUsd: costUsd(model, usage), model };
    }
    return { ...heuristicRoute(question), reason: `router replied "${word}"; used heuristic` };
  } catch (err) {
    return { ...heuristicRoute(question), reason: `router failed (${(err as Error).message}); used heuristic` };
  }
}
