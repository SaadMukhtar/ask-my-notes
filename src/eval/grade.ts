import type { GoldenItem } from "./golden";

export interface Candidate {
  answer: string;
  refused: boolean;
  citedPaths: string[];
}

export interface DeterministicGrade {
  pass: boolean;
  /** Which must_include groups were missing, which forbidden strings appeared, etc. */
  reasons: string[];
  /** Did the answer cite at least one of the expected docs? (null for unanswerable questions) */
  citedExpected: boolean | null;
}

/**
 * Code-based grading: cheap, deterministic, and exactly reproducible, which is why the CI gate uses it.
 * It checks *key facts* (must_include), *forbidden content* (must_not_include, e.g. text from a prompt
 * injection), refusal behaviour, and that answers cite something. It cannot judge wording, so a
 * correct answer that phrases a fact differently ("five minutes" vs "5 minutes") needs alternatives
 * in the golden set ("5 minutes|five minutes"). The LLM judge covers what substring checks cannot.
 */
export function gradeDeterministic(item: GoldenItem, c: Candidate): DeterministicGrade {
  const reasons: string[] = [];
  const text = normalise(c.answer);
  if (item.should_refuse) {
    if (!c.refused) reasons.push("should have refused (answer is not in the notes)");
    return { pass: reasons.length === 0, reasons, citedExpected: null };
  }
  if (c.refused) reasons.push("refused an answerable question");
  for (const group of item.must_include) {
    if (!group.split("|").some((alt) => containsTerm(text, normalise(alt)))) reasons.push(`missing "${group}"`);
  }
  for (const bad of item.must_not_include) if (text.includes(normalise(bad))) reasons.push(`contains forbidden "${bad}"`);
  if (!c.refused && c.citedPaths.length === 0) reasons.push("no citations");
  const expected = new Set(item.expected_docs.flatMap((s) => s.split("|")));
  const citedExpected = c.citedPaths.some((p) => expected.has(p));
  return { pass: reasons.length === 0, reasons, citedExpected };
}

/**
 * Substring match that must start at a word boundary, so "5 minutes" does not match "15 minutes"
 * (grader v2; v1 used plain substrings and passed a wrong answer in the labelled set). The end is
 * left open on purpose so "maker morning" still matches "maker mornings".
 */
export function containsTerm(text: string, term: string): boolean {
  let i = text.indexOf(term);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1])) return true;
    i = text.indexOf(term, i + 1);
  }
  return false;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\*\*/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
}
