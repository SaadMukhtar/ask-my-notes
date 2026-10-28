import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { REFUSAL } from "../src/answer/prompt";
import { config } from "../src/config";
import { gradeDeterministic } from "../src/eval/grade";
import { loadGolden } from "../src/eval/golden";
import { agreement, judge, JUDGE_VERSION } from "../src/eval/judge";
import { getLLM } from "../src/llm/client";

/**
 * How much can we trust our graders? Compare them with human labels on evals/judge-labels.jsonl.
 * Re-label: edit "human_label" (pass/fail) in that file, then re-run this script.
 *   npm run eval:judge-agreement [-- --write-baseline]
 */
interface Label { label_id: string; question_id: string; candidate_answer: string; human_label: "pass" | "fail"; note: string }
const labels: Label[] = readFileSync("evals/judge-labels.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const golden = new Map(loadGolden().map((g) => [g.id, g]));
const human = labels.map((l) => l.human_label === "pass");

const det = labels.map((l) => {
  const g = golden.get(l.question_id)!;
  const refused = l.candidate_answer.startsWith(REFUSAL);
  // Labelled candidates are standalone text; treat any [S#] marker as "has a citation".
  const citedPaths = /\[S\d+\]/.test(l.candidate_answer) ? ["(cited)"] : [];
  return gradeDeterministic(g, { answer: l.candidate_answer, refused, citedPaths }).pass;
});
const detAgree = agreement(human, det);

const fmt = (a: ReturnType<typeof agreement>) =>
  `agreement ${(a.accuracy * 100).toFixed(1)}% (n=${a.n}), Cohen's kappa ${a.kappa.toFixed(2)}, ` +
  `grader-pass-but-human-fail ${a.confusion.fp}, grader-fail-but-human-pass ${a.confusion.fn}`;
console.log(`Labelled set: ${labels.length} answers (${human.filter(Boolean).length} human pass, ${human.filter((x) => !x).length} human fail)\n`);
console.log(`Deterministic grader vs human: ${fmt(detAgree)}`);
labels.forEach((l, i) => det[i] !== human[i] && console.log(`  disagree ${l.label_id} (${l.question_id}): human=${l.human_label} det=${det[i] ? "pass" : "fail"}  ${l.note}`));

let judgeAgree: ReturnType<typeof agreement> | null = null;
const llm = (() => { try { return getLLM(); } catch { return null; } })();
if (llm?.provider === "anthropic") {
  const verdicts: boolean[] = [];
  for (const l of labels) {
    const g = golden.get(l.question_id)!;
    const v = await judge(llm, config.answerModel, { question: g.question, reference: g.reference_answer, shouldRefuse: g.should_refuse, answer: l.candidate_answer });
    verdicts.push(v.verdict === "pass");
    if ((v.verdict === "pass") !== (l.human_label === "pass")) console.log(`  judge disagrees ${l.label_id}: human=${l.human_label} judge=${v.verdict} (${v.reasoning})`);
  }
  judgeAgree = agreement(human, verdicts);
  const both = agreement(human, verdicts.map((v, i) => v && det[i]));
  console.log(`\nLLM judge (${config.answerModel}, ${JUDGE_VERSION}) vs human: ${fmt(judgeAgree)}`);
  console.log(`Judge AND deterministic (the eval's headline grader) vs human: ${fmt(both)}`);
} else {
  console.log(`\nLLM judge: not run (needs LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY).`);
}

if (process.argv.includes("--write-baseline")) {
  const path = "evals/baseline.json";
  const b = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  b.grader_agreement = {
    labels: labels.length,
    deterministic: { accuracy: detAgree.accuracy, kappa: detAgree.kappa },
    judge: judgeAgree ? { model: config.answerModel, version: JUDGE_VERSION, accuracy: judgeAgree.accuracy, kappa: judgeAgree.kappa } : null,
  };
  writeFileSync(path, JSON.stringify(b, null, 2) + "\n");
}
