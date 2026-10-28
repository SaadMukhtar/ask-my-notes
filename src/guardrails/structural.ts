import { REFUSAL } from "../answer/prompt";
import { citedIds, needsCitation, splitClaims } from "../answer/citations";
import type { ClaimCheck, Verifier } from "./types";

/**
 * The cheapest possible citation check: every [S#] must point at a source the agent actually saw,
 * and every factual-looking sentence must cite something. It does not check that the source
 * *supports* the claim; that is stage 6's job (src/guardrails/verify.ts).
 */
export const structuralVerifier: Verifier = async (answer, registry) => {
  if (answer.startsWith(REFUSAL)) return { ok: true, problems: [], checks: [] };
  const checks: ClaimCheck[] = splitClaims(answer).map((c) => {
    if (c.sourceIds.some((id) => !registry.get(id))) return { claim: c.claim, sourceIds: c.sourceIds, verdict: "bad_id", why: "cites a source id that does not exist" };
    if (!c.sourceIds.length) return { claim: c.claim, sourceIds: [], verdict: needsCitation(c.claim) ? "uncited" : "skipped" };
    return { claim: c.claim, sourceIds: c.sourceIds, verdict: "supported", why: "structural check only" };
  });
  const problems = checks
    .filter((c) => c.verdict === "bad_id" || c.verdict === "uncited")
    .map((c) => `"${c.claim}" ${c.verdict === "bad_id" ? `cites unknown source ${c.sourceIds.join(", ")}` : "has no citation"}`);
  if (citedIds(answer).length === 0) problems.push("the answer cites no sources at all");
  return { ok: problems.length === 0, problems, checks };
};
