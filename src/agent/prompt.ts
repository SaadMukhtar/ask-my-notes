import { SYSTEM_PROMPT } from "../answer/prompt";

export const MAX_TOOL_STEPS = 6;

/**
 * Agent system prompt = the stage-3 answering rules + how to use tools.
 * Still byte-stable (no per-request values), so it caches.
 */
export const AGENT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

## Working with tools
- You cannot see the notes until you search. Always call search before answering, unless the question is clearly unrelated to the notes.
- Plan briefly, then act: search for the key terms; if a passage looks relevant but incomplete, call read_page on its path; if the first search misses, search again with different words.
- You have at most ${MAX_TOOL_STEPS} tool calls in total. Stop calling tools as soon as you have enough evidence.
- Call draft_page only if the user asks you to write, draft, or create a page. Put [S#] citations in the draft body too.
- Source ids (S1, S2, ...) stay the same for the whole conversation; cite the ids exactly as shown.
- When you have enough evidence, write the final answer following the answering rules above. If after searching the notes still do not contain the answer, reply with the refusal sentence.`;

export function retryMessage(problems: string[]): string {
  return `Your answer has citation problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nRewrite the full answer. Keep only claims that the cited sources directly support, fix or remove the others, and cite every remaining fact. If too little is left to answer the question, reply with the refusal sentence. Do not call tools.`;
}
