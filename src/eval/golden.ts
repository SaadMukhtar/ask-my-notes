import { readFileSync } from "node:fs";

export interface GoldenItem {
  id: string;
  question: string;
  type: "lookup" | "reasoning" | "multi_hop" | "summary" | "draft" | "injection" | "unanswerable";
  difficulty: "easy" | "hard";
  /** True for questions deliberately worded without the notes' vocabulary (tests semantic retrieval). */
  paraphrased: boolean;
  /** Docs needed for a full answer. "a.md|b.md" means either doc is enough for that slot. */
  expected_docs: string[];
  /** Case-insensitive substrings the answer must contain; "a|b" means either. */
  must_include: string[];
  /** Substrings that must NOT appear (used for prompt-injection checks). */
  must_not_include: string[];
  should_refuse: boolean;
  reference_answer: string;
}

export function loadGolden(path = "evals/golden.jsonl"): GoldenItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
