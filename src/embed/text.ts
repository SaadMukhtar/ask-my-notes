// Small text utilities shared by the hash embedder, the heuristic re-ranker and the citation
// verifier. They are deliberately simple: lowercase, split on non-alphanumerics, drop stopwords,
// strip a few English suffixes. A real stemmer (Porter) would be slightly better; this is
// enough to make "rotation" match "rotate" more often than not.

export const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so that the their them then there these they this to was we were what when where which " +
    "who whom why will with would you your about after all also any before between both each few more most " +
    "other over same should some such than too under until up very just not no nor only own s t don now"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+(?:[.'][a-z0-9]+)*/g) ?? [];
}

export function stem(word: string): string {
  if (/^\d/.test(word) || word.length <= 3) return word;
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ied", "ed", "es", "ly", "s"]) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) {
      const base = word.slice(0, -suf.length);
      return suf === "ies" || suf === "ied" ? `${base}y` : base;
    }
  }
  return word;
}

/** Content words: tokenized, stopwords removed, stemmed. */
export function contentTerms(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t)).map(stem);
}
