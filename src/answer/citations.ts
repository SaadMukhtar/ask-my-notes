export interface Claim {
  /** The sentence as written, citations included. */
  text: string;
  /** The sentence with citation markers removed (what we verify against the sources). */
  claim: string;
  /** Source ids cited by this sentence, e.g. ["S1", "S3"]. */
  sourceIds: string[];
  /** True when the sentence had no marker of its own and took the next sentence's citations (see below). */
  inherited?: boolean;
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
    const lineClaims: Claim[] = [];
    for (const p of parts) {
      const sourceIds = [...new Set([...p.matchAll(CITE)].map((m) => m[1]))];
      const claim = p.replace(CITE, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\*\*/g, "").trim();
      if (claim) lineClaims.push({ text: p, claim, sourceIds });
    }
    // Writers often cite once at the end of a run of sentences from the same source:
    // "Lag hit 40 minutes. The cutover moved to October 4 [S2]." Within one line, an uncited
    // sentence inherits the citations of the next cited sentence. The stage 6 verifier still checks
    // that the inherited source really supports it, so this cannot hide an unsupported claim.
    for (let i = lineClaims.length - 2; i >= 0; i--) {
      if (!lineClaims[i].sourceIds.length && lineClaims[i + 1].sourceIds.length) {
        lineClaims[i].sourceIds = [...lineClaims[i + 1].sourceIds];
        lineClaims[i].inherited = true;
      }
    }
    out.push(...lineClaims);
  }
  return out;
}

/** A claim needs a citation if it states something; headings, greetings and short glue text do not. */
export function needsCitation(claim: string): boolean {
  if (claim.length < 25) return false;
  if (/:$/.test(claim)) return false; // "Here is what I found:"
  // Statements about the assistant's own actions, not about the notes.
  if (/^(I|I've|I have|Here is|Here's|Below is|This draft|The draft)\b/i.test(claim)) return false;
  return true;
}
