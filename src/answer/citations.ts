export interface Claim {
  /** The sentence as written, citations included. */
  text: string;
  /** The sentence with citation markers removed (what we verify against the sources). */
  claim: string;
  /** Source ids cited by this sentence, e.g. ["S1", "S3"]. */
  sourceIds: string[];
}

const CITE = /\[(S\d+)\]/g;

/** All distinct source ids cited anywhere in the answer, in order of first appearance. */
export function citedIds(answer: string): string[] {
  return [...new Set([...answer.matchAll(CITE)].map((m) => m[1]))];
}

/**
 * Split an answer into sentence-level claims with their citations.
 * We split on line breaks (bullets) and sentence ends. A citation that comes right after the period
 * ("... page. [S1]") is attached to the sentence before it.
 */
export function splitClaims(answer: string): Claim[] {
  const out: Claim[] = [];
  for (const rawLine of answer.split(/\n+/)) {
    const line = rawLine.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/^#+\s+/, "").trim();
    if (!line) continue;
    // Split after ".", "!" or "?" when followed by whitespace and a capital letter / digit / quote,
    // keeping trailing citation markers with the sentence they follow.
    const parts = line.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z0-9"“(])/);
    for (const p of parts) {
      const sourceIds = [...new Set([...p.matchAll(CITE)].map((m) => m[1]))];
      const claim = p.replace(CITE, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\*\*/g, "").trim();
      if (claim) out.push({ text: p, claim, sourceIds });
    }
  }
  return out;
}

/** A claim needs a citation if it states something; headings, greetings and short glue text do not. */
export function needsCitation(claim: string): boolean {
  if (claim.length < 25) return false;
  if (/:$/.test(claim)) return false; // "Here is what I found:"
  return true;
}
