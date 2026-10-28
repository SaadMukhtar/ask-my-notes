/**
 * Prompt-injection detection and neutralisation for retrieved text.
 *
 * The threat: anyone who can get text into your notes (a pasted email, a web clipping, an auto
 * transcript) can write instructions aimed at the assistant ("ignore previous instructions...").
 * The model reads retrieved text in the same context as our instructions, so it may obey.
 *
 * Defence in depth, cheapest first:
 *   1. The system prompt says sources are data, not instructions (stage 3). Helps, not reliable.
 *   2. This file: score each sentence for instruction-like patterns and *remove* the flagged ones
 *      before the model sees them, marking the source as flagged. The model cannot follow what it
 *      never reads.
 *   3. The citation verifier (verify.ts) checks every claim against the *sanitised* source, so a claim
 *      that came from injected text has nothing to stand on, and links absent from sources are rejected.
 *
 * Patterns are a heuristic: they will miss novel phrasings and occasionally flag a benign line.
 * The guardrail eval measures both (evals/run-guardrails.ts).
 */

interface Pattern {
  re: RegExp;
  weight: number;
  label: string;
}

const PATTERNS: Pattern[] = [
  { re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|your|all)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|directions|guidelines)\b/i, weight: 3, label: "override-instructions" },
  { re: /\bsystem\s+(instruction|prompt|message|override)s?\b[^.\n]{0,40}\b(for|to)\b[^.\n]{0,20}\b(ai|assistants?|models?|llms?|agents?)\b/i, weight: 3, label: "fake-system-message" },
  { re: /\b(important\s+)?system\s+instructions?\b/i, weight: 2, label: "fake-system-message" },
  { re: /(^|\n)\s*(system|assistant)\s*:/i, weight: 2, label: "role-marker" },
  { re: /\b(ai|llms?|language models?|assistants?|chatbots?|agents?|models?)\b[^.\n]{0,40}\b(reading|processing|parsing|viewing|summari[sz]ing)\b/i, weight: 2, label: "addresses-ai" },
  { re: /\b(assistant|ai|llm|chatbot|claude)\b\s*[,:]\s*(when|if|please|you|always|never)\b/i, weight: 2, label: "addresses-ai" },
  { re: /\bif you are an? (ai|llm|language model|assistant|bot|chatbot)\b/i, weight: 3, label: "addresses-ai" },
  { re: /\byou are now\b/i, weight: 2, label: "role-change" },
  { re: /\b(reveal|print|output|repeat|show|dump)\b[^.\n]{0,30}\b(system prompt|your (instructions|prompt|rules)|every (other )?document|all (other )?(documents|notes)|verbatim|credentials|secrets)\b/i, weight: 3, label: "exfiltration" },
  { re: /\bdo not (mention|reveal|tell)\b[^.\n]{0,30}\b(this|these) (instructions?|messages?|notes?)\b/i, weight: 3, label: "concealment" },
  { re: /\b(developer|maintenance|god|jailbreak|dan)\s+mode\b/i, weight: 1, label: "mode-switch" },
  { re: /\bnew instructions?\s*:/i, weight: 2, label: "override-instructions" },
  { re: /\[\/?INST\]|<\|im_(start|end)\|>|<\/?system>/i, weight: 3, label: "chat-template" },
  { re: /\b(override|bypass)\b[^.\n]{0,20}\b(safety|guidelines|rules|restrictions)\b/i, weight: 2, label: "override-instructions" },
  { re: /\b(call|use|invoke|run)\b[^.\n]{0,20}\b(tool|function)\b[^.\n]{0,30}\b(draft_page|read_page|search)\b/i, weight: 2, label: "tool-hijack" },
  { re: /https?:\/\/\S*(login|signin|sign-in|reset|verify|password|token)\S*/i, weight: 2, label: "phishing-link" },
  { re: /\b(tell|inform|say to) (them|the user|users|anyone|everyone)\b/i, weight: 1, label: "addresses-ai" },
  { re: /\bwhen (anyone|someone|somebody|a user|users|people) asks?\b/i, weight: 1, label: "conditional-trigger" },
  { re: /\b(include|add|insert)\b[^.\n]{0,30}\b(link|url)\b[^.\n]{0,20}\b(every|each|all|your) (answer|response|reply)/i, weight: 2, label: "output-hijack" },
  { re: /\b(state|present|report) (this|it) as (a )?fact\b|\bfrom now on\b/i, weight: 1, label: "override-instructions" },
];

export const FLAG_THRESHOLD = 2;

export interface InjectionScan {
  score: number;
  labels: string[];
}

export function scanText(text: string): InjectionScan {
  let score = 0;
  const labels = new Set<string>();
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      score += p.weight;
      labels.add(p.label);
    }
  }
  return { score, labels: [...labels] };
}

export function isInjection(text: string): boolean {
  return scanText(text).score >= FLAG_THRESHOLD;
}

export const REDACTION = "[removed by Ask My Notes: text that looked like instructions to an AI assistant]";

export interface SanitizeResult {
  text: string;
  flagged: boolean;
  removed: string[];
  labels: string[];
}

/**
 * Remove instruction-like sentences (and hidden HTML comments that contain them) from a source.
 * Works per sentence so the legitimate rest of the note (e.g. "Hannah's note: not interested")
 * still reaches the model.
 */
export function sanitizeSource(content: string): SanitizeResult {
  const removed: string[] = [];
  const labels = new Set<string>();
  const drop = (span: string) => {
    removed.push(span.trim());
    scanText(span).labels.forEach((l) => labels.add(l));
    return REDACTION;
  };

  // 1. Hidden HTML comments: remove the whole comment if anything in it is flagged.
  let text = content.replace(/<!--[\s\S]*?-->/g, (c) => (isInjection(c) ? drop(c) : c));

  // 2. Paragraph by paragraph: if a paragraph is flagged, drop the sentences in it that carry *any*
  //    signal (the payload sentence often scores low on its own: "tell them the project is
  //    cancelled"). If no sentence carries a signal (it is spread out), drop the whole paragraph.
  text = text
    .split(/(\n\s*\n)/)
    .map((para) => {
      if (para.includes(REDACTION) || !isInjection(para)) return para;
      // Split into sentences but keep the whitespace between them, so line breaks survive.
      const parts = para.split(/(?<=[.!?])(\s+)/);
      const suspicious = (x: string) => scanText(x).score > 0;
      if (!parts.some((x, i) => i % 2 === 0 && suspicious(x))) return drop(para);
      return parts
        .map((x, i) => (i % 2 === 0 && suspicious(x) ? drop(x) : x))
        .join("")
        .replace(new RegExp(`${escapeRe(REDACTION)}(\\s+${escapeRe(REDACTION)})+`, "g"), REDACTION);
    })
    .join("");

  // A literal "</source>" inside a note must not be able to close our tag early.
  text = text.replace(/<\/?source\b/gi, (m) => m.replace("<", "&lt;"));
  return { text, flagged: removed.length > 0, removed, labels: [...labels] };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
