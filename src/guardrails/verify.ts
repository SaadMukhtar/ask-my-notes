import type { SourceRegistry } from "../agent/sources";
import { REFUSAL } from "../answer/prompt";
import { needsCitation, splitClaims, type Claim } from "../answer/citations";
import { config } from "../config";
import { contentTerms, stem } from "../embed/text";
import type { LLM } from "../llm/client";
import { textOf } from "../llm/client";
import { addUsage, costUsd, fromApiUsage, ZERO_USAGE } from "../llm/pricing";
import type { Hit } from "../retrieve/types";
import { sanitizeSource } from "./injection";
import type { ClaimCheck, Verifier, VerifyResult } from "./types";

/**
 * Stage 6 citation verification: does each cited source actually support its sentence?
 *
 * Tier 1, lexical (free, instant, always on):
 *   - every number in the claim ("5 minutes", "$1,200", "October 4") must appear in a cited source;
 *   - most of the claim's content words must appear in the cited sources (coverage).
 *   Numbers are where hallucinations hurt most and where word overlap is most misleading.
 * Tier 2, LLM (Haiku, only with a key, only for claims tier 1 could not confirm): asks whether the
 *   cited text entails the claim. Catches paraphrases ("a quarter of an hour" = 15 minutes) that
 *   tier 1 rejects, and is the only tier that understands meaning.
 * Both tiers compare against the *sanitised* source, so text removed as a prompt injection can
 * never support a claim.
 */

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
};

/** Numbers in a text, normalised: "$1,200" -> "1200", "10:00" -> "10:00", "99.5%" -> "99.5", "five" -> "5". */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/\d[\d,]*(?:[.:]\d+)?/g)) out.add(normNum(m[0]));
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (NUMBER_WORDS[w]) out.add(NUMBER_WORDS[w]);
  return out;
}

function normNum(raw: string): string {
  return raw.replace(/,+$/, "").replace(/,(?=\d{3}\b)/g, "").replace(/\.0+$/, "");
}

const SKIP = new Set<string>(["per", "a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "at"]);

/**
 * Numbers with their units. "Each pod opened 40 connections" is wrong even though "40" appears in the
 * source ("40 pods"). For each number in the claim, take its unit (the first word within two tokens
 * after it) and require that some occurrence of that number in the source has the same word within
 * four words on either side. Numbers with no unit word ("by October 4.") are only checked for presence.
 */
export function unitMismatches(claim: string, source: string): string[] {
  const toks = (t: string): string[] => t.toLowerCase().replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:[.:]\d+)?|[a-z]+/g) ?? [];
  const isNum = (t: string) => /^\d/.test(t);
  const unitStem = (t: string) => stem(t);
  const c = toks(claim);
  const sTok = toks(source);
  const bad: string[] = [];
  c.forEach((t, i) => {
    if (!isNum(t)) return;
    let unit: string | undefined;
    for (let j = i + 1; j <= i + 2 && j < c.length; j++) {
      if (isNum(c[j])) break;
      if (SKIP.has(c[j])) continue;
      unit = unitStem(c[j]);
      break;
    }
    if (!unit) return;
    const ok = sTok.some((s, k) => {
      if (s !== t) return false;
      const window = [...sTok.slice(Math.max(0, k - 4), k), ...sTok.slice(k + 1, k + 5)].filter((w) => !isNum(w)).map(unitStem);
      return window.includes(unit!);
    });
    if (!ok && sTok.includes(t)) bad.push(`${t} ${unit}`);
  });
  return bad;
}

export const COVERAGE_THRESHOLD = 0.6;

export function lexicalSupport(claim: string, sourceTexts: string[]): { supported: boolean; score: number; why: string } {
  const src = sourceTexts.join("\n");
  const srcNums = numbersIn(src);
  // Years and the S-ids themselves are not facts to check.
  const missingNums = [...numbersIn(claim)].filter((n) => !srcNums.has(n));
  const terms = [...new Set(contentTerms(claim))];
  const srcTerms = new Set(contentTerms(src));
  const coverage = terms.length ? terms.filter((t) => srcTerms.has(t)).length / terms.length : 1;
  if (missingNums.length) return { supported: false, score: coverage, why: `number(s) ${missingNums.join(", ")} not in the cited source` };
  const units = unitMismatches(claim, src);
  if (units.length) return { supported: false, score: coverage, why: `"${units.join('", "')}" does not match how the source uses those numbers` };
  if (coverage < COVERAGE_THRESHOLD) return { supported: false, score: coverage, why: `only ${(coverage * 100).toFixed(0)}% of the claim's words appear in the cited source` };
  return { supported: true, score: coverage, why: `numbers match; ${(coverage * 100).toFixed(0)}% word coverage` };
}

const urlRe = /https?:\/\/[^\s)\]>]+/g;

function sanitized(h: Hit): string {
  return `${h.headingPath}\n${sanitizeSource(h.content).text}`;
}

/** Verify one answer. `llm` enables tier 2. */
export async function verifyAnswer(answer: string, registry: SourceRegistry, llm?: LLM, model = config.routerModel): Promise<VerifyResult> {
  if (answer.startsWith(REFUSAL)) return { ok: true, problems: [], checks: [] };
  const claims = splitClaims(answer);
  const checks: ClaimCheck[] = [];
  const toLLM: { idx: number; claim: Claim; sources: string[] }[] = [];

  for (const c of claims) {
    if (!c.sourceIds.length) {
      checks.push({ claim: c.claim, sourceIds: [], verdict: needsCitation(c.claim) ? "uncited" : "skipped" });
      continue;
    }
    const hits = c.sourceIds.map((id) => registry.get(id));
    if (hits.some((h) => !h)) {
      checks.push({ claim: c.claim, sourceIds: c.sourceIds, verdict: "bad_id", why: "cites a source id that does not exist" });
      continue;
    }
    const texts = (hits as Hit[]).map(sanitized);
    const lex = lexicalSupport(c.claim, texts);
    checks.push({ claim: c.claim, sourceIds: c.sourceIds, verdict: lex.supported ? "supported" : "unsupported", score: lex.score, why: `lexical: ${lex.why}` });
    if (!lex.supported && llm) toLLM.push({ idx: checks.length - 1, claim: c, sources: texts });
  }

  let usage = { ...ZERO_USAGE };
  let cost = 0;
  if (toLLM.length && llm) {
    const out = await llmEntailment(llm, model, toLLM.map((x) => ({ claim: x.claim.claim, sources: x.sources })));
    usage = addUsage(usage, out.usage);
    cost += out.costUsd;
    out.verdicts.forEach((v, i) => {
      const check = checks[toLLM[i].idx];
      check.verdict = v.supported ? "supported" : "unsupported";
      check.why = `${check.why}; llm: ${v.reason}`;
    });
  }

  // Links are a classic exfiltration / phishing channel: an answer may only contain URLs that
  // appear in the (sanitised) sources it saw.
  const allowed = new Set(registry.sources.flatMap((h) => sanitizeSource(h.content).text.match(urlRe) ?? []));
  const badLinks = (answer.match(urlRe) ?? []).filter((u) => !allowed.has(u));

  const problems = [
    ...checks.filter((c) => c.verdict === "unsupported").map((c) => `[${c.sourceIds.join("][")}] does not support "${c.claim}" (${c.why})`),
    ...checks.filter((c) => c.verdict === "uncited").map((c) => `"${c.claim}" has no citation`),
    ...checks.filter((c) => c.verdict === "bad_id").map((c) => `"${c.claim}" cites unknown source ${c.sourceIds.join(", ")}`),
    ...badLinks.map((u) => `link ${u} does not appear in any source`),
  ];
  if (!checks.some((c) => c.sourceIds.length)) problems.push("the answer cites no sources at all");
  return { ok: problems.length === 0, problems, checks, usage, costUsd: cost };
}

const ENTAIL_SYSTEM = `You check whether quoted source passages support claims.
For each numbered item, answer "supported" only if the passages state the claim or directly imply it (paraphrase is fine, same meaning required, numbers and names must match). Answer "unsupported" if the claim adds facts, changes numbers, or the passages are about something else.`;

async function llmEntailment(llm: LLM, model: string, items: { claim: string; sources: string[] }[]) {
  const body = items
    .map((it, i) => `<item n="${i + 1}">\n<passages>\n${it.sources.join("\n---\n")}\n</passages>\n<claim>${it.claim}</claim>\n</item>`)
    .join("\n\n");
  const msg = await llm.stream(
    {
      model,
      max_tokens: 2000,
      system: ENTAIL_SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: { n: { type: "integer" }, verdict: { type: "string", enum: ["supported", "unsupported"] }, reason: { type: "string" } },
                  required: ["n", "verdict", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["results"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: body }],
    },
    { timeoutMs: 30_000 },
  );
  const usage = fromApiUsage(msg.usage);
  const parsed = JSON.parse(textOf(msg)) as { results: { n: number; verdict: string; reason: string }[] };
  const byN = new Map(parsed.results.map((r) => [r.n, r]));
  return {
    usage,
    costUsd: costUsd(model, usage),
    // A missing item counts as unsupported: fail closed.
    verdicts: items.map((_, i) => ({ supported: byN.get(i + 1)?.verdict === "supported", reason: byN.get(i + 1)?.reason ?? "no verdict returned" })),
  };
}

/** Verifier factory used by the agent. "llm" = lexical + Haiku second opinion. */
export function makeVerifier(kind: "lexical" | "llm", llm?: LLM): Verifier {
  return (answer, registry) => verifyAnswer(answer, registry, kind === "llm" ? llm : undefined);
}
