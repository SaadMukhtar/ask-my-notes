import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SourceRegistry } from "../src/agent/sources";
import { config } from "../src/config";
import { isInjection, sanitizeSource } from "../src/guardrails/injection";
import { verifyAnswer } from "../src/guardrails/verify";
import { listMarkdown } from "../src/ingest/ingest";
import { getLLM, type LLM } from "../src/llm/client";

/**
 * Guardrail eval, no agent involved:
 *   1. Citation verifier on 39 hand-labelled (claim, source) pairs.
 *   2. Injection detector on 30 hand-written strings (15 attacks, 15 look-alike benign lines).
 *   3. Injection detector on every note in the corpus (3 notes contain planted injections).
 *   npm run eval:guardrails [-- --gate] [-- --write-baseline]
 */
const args = process.argv.slice(2);
const read = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Binary metrics where "positive" = the thing the guardrail should catch. */
function binary(truth: boolean[], pred: boolean[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  truth.forEach((t, i) => (t && pred[i] ? tp++ : !t && pred[i] ? fp++ : t ? fn++ : tn++));
  return { n: truth.length, accuracy: (tp + tn) / truth.length, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), tp, fp, fn, tn };
}

// ── 1. Citation verifier ─────────────────────────────────────────────────────────────────────
interface VPair { id: string; path: string; source_text: string; claim: string; supported: boolean; kind: string }
const pairs = read<VPair>("evals/verifier-labels.jsonl");
async function runVerifier(llm?: LLM) {
  const preds: boolean[] = [];
  let cost = 0;
  for (const p of pairs) {
    const reg = new SourceRegistry();
    reg.register({ chunkId: 1, path: p.path, title: p.path, headingPath: path.basename(p.path, ".md"), content: p.source_text, score: 0, signals: {} });
    const v = await verifyAnswer(`${p.claim.replace(/\.$/, "")} [S1].`, reg, llm);
    cost += v.costUsd ?? 0;
    preds.push(v.checks[0]?.verdict === "supported");
  }
  // positive class = "unsupported" (what the verifier must catch)
  const m = binary(pairs.map((p) => !p.supported), preds.map((s) => !s));
  return { ...m, cost, preds };
}
const lex = await runVerifier();
console.log(`1. Citation verifier, ${pairs.length} labelled pairs (${pairs.filter((p) => !p.supported).length} unsupported)`);
const fmtV = (name: string, m: typeof lex) =>
  `   ${name}: accuracy ${pct(m.accuracy)}; catches ${m.tp}/${m.tp + m.fn} unsupported claims (recall ${pct(m.recall)}), ` +
  `wrongly rejects ${m.fp}/${m.fp + m.tn} supported claims (precision ${pct(m.precision)})`;
console.log(fmtV("lexical", lex));
pairs.forEach((p, i) => lex.preds[i] !== p.supported && console.log(`     miss ${p.id} [${p.kind}] label=${p.supported ? "supported" : "unsupported"}: ${p.claim}`));

let llmV: Awaited<ReturnType<typeof runVerifier>> | null = null;
const llm = (() => { try { const l = getLLM(); return l.provider === "anthropic" ? l : null; } catch { return null; } })();
if (llm) {
  llmV = await runVerifier(llm);
  console.log(fmtV(`lexical + ${config.routerModel}`, llmV) + ` ($${llmV.cost.toFixed(4)})`);
} else console.log(`   lexical + LLM: not run (needs LLM_PROVIDER=anthropic and a key)`);

// ── 2. Injection detector on labelled strings ────────────────────────────────────────────────
interface ICase { id: string; text: string; is_injection: boolean }
const cases = read<ICase>("evals/injection-cases.jsonl");
const det = binary(cases.map((c) => c.is_injection), cases.map((c) => isInjection(c.text)));
console.log(`\n2. Injection detector, ${cases.length} labelled strings: catches ${det.tp}/${det.tp + det.fn} attacks (recall ${pct(det.recall)}), flags ${det.fp}/${det.fp + det.tn} benign look-alikes`);
cases.forEach((c) => isInjection(c.text) !== c.is_injection && console.log(`     miss ${c.id} (${c.is_injection ? "attack not caught" : "benign flagged"}): ${c.text}`));

// ── 3. Injection detector on the corpus ──────────────────────────────────────────────────────
const files = await listMarkdown(config.notesDir);
const flagged = [];
for (const f of files) {
  const s = sanitizeSource(readFileSync(path.join(config.notesDir, f), "utf8"));
  if (s.flagged) flagged.push({ f, removed: s.removed.length, labels: s.labels });
}
const planted = new Set(["inbox/forecastiq-sales-email.md", "inbox/clipping-postgres-tuning.md", "inbox/meeting-transcript-autogen.md"]);
const corpusTP = flagged.filter((x) => planted.has(x.f)).length;
const corpusFP = flagged.filter((x) => !planted.has(x.f)).length;
console.log(`\n3. Corpus scan (${files.length} notes): ${corpusTP}/${planted.size} planted-injection notes flagged, ${corpusFP} clean notes flagged`);
for (const x of flagged) console.log(`     ${x.f}: ${x.removed} span(s) removed [${x.labels.join(", ")}]`);

const summary = {
  verifier_lexical: { accuracy: lex.accuracy, recall_unsupported: lex.recall, precision_unsupported: lex.precision },
  verifier_llm: llmV ? { model: config.routerModel, accuracy: llmV.accuracy, recall_unsupported: llmV.recall, precision_unsupported: llmV.precision } : null,
  injection_cases: { recall: det.recall, false_positives: det.fp, n: cases.length },
  injection_corpus: { planted_flagged: corpusTP, planted: planted.size, clean_flagged: corpusFP },
};
const BASELINE = "evals/baseline.json";
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
let exit = 0;
if (args.includes("--write-baseline")) {
  baseline.guardrails = { ...summary, measured_at: new Date().toISOString().slice(0, 10) };
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log("\nWrote guardrail baseline");
}
if (args.includes("--gate")) {
  const b = baseline.guardrails;
  const fails: string[] = [];
  if (!b) console.log("\n[gate] no guardrail baseline; skipping");
  else {
    if (lex.accuracy < b.verifier_lexical.accuracy) fails.push(`verifier accuracy ${pct(lex.accuracy)} < ${pct(b.verifier_lexical.accuracy)}`);
    if (det.recall < b.injection_cases.recall) fails.push(`injection recall ${pct(det.recall)} < ${pct(b.injection_cases.recall)}`);
    if (det.fp > b.injection_cases.false_positives) fails.push(`injection false positives ${det.fp} > ${b.injection_cases.false_positives}`);
    if (corpusTP < b.injection_corpus.planted_flagged || corpusFP > b.injection_corpus.clean_flagged) fails.push("corpus scan regressed");
    console.log(fails.length ? `\n[gate] FAIL: ${fails.join("; ")}` : "\n[gate] PASS");
    exit = fails.length ? 1 : 0;
  }
}
process.exit(exit);
