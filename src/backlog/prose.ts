/**
 * Whether a finding's problem text is written for both of its readers.
 *
 * The rubric asks the judge for a `problem` in two parts: a plain sentence a
 * person who has never seen the screen can follow, then the precise statement
 * an agent acts on, separated by a blank line. Nothing on the code side read
 * that rule, so a reply that skipped the plain half, or repeated the title,
 * was ingested as written and the document had two places quietly hiding
 * the degenerate case at render time. This is the one bar, used at ingest
 * (to count the lapse), by the refuter (to know when its own sentence is
 * needed), by `backlog check` (to flag the record) and by the renderers.
 */
export type ProseLapse = "empty" | "title-again" | "one-part" | "plain-too-short" | "label-in-plain";

const MIN_PLAIN = 40;

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();

/** The plain half and the precise half, split on the first blank line. */
export function splitProblem(problem: string): { plain: string; detail: string | null } {
  const text = problem.trim();
  const at = text.search(/\n[ \t]*\n/);
  if (at < 0) return { plain: text, detail: null };
  return { plain: text.slice(0, at).trim(), detail: text.slice(at).trim() };
}

/** The lapses in a problem text, worst first; empty when it meets the bar. */
export function problemLapses(f: { title: string; problem: string; attribute?: string }): ProseLapse[] {
  const out: ProseLapse[] = [];
  const problem = f.problem.trim();
  if (problem === "") return ["empty"];
  if (normalise(problem) === normalise(f.title)) return ["title-again"];
  const { plain, detail } = splitProblem(problem);
  if (detail === null) out.push("one-part");
  if (plain.length < MIN_PLAIN) out.push("plain-too-short");
  // A backticked token, or the attribute token when it is not an ordinary
  // word, is a label in the half that is meant to have none. Category names
  // like "contrast" or "spacing" are English and are never treated as labels.
  const attribute = f.attribute && f.attribute.includes("-") ? f.attribute : null;
  if (/`[^`]+`/.test(plain) || (attribute && new RegExp(`\\b${attribute}\\b`).test(plain))) out.push("label-in-plain");
  return out;
}

const HARD: ReadonlySet<ProseLapse> = new Set(["empty", "title-again", "one-part"]);

/** The degenerate case a renderer drops: nothing, or the title over again. */
export function isTitleAgain(problem: string, title: string): boolean {
  const p = problem.trim();
  return p === "" || normalise(p) === normalise(title);
}

/** Written for both readers: no hard lapse. The soft ones are advice, not failure. */
export function isExplained(problem: string, title: string): boolean {
  return !problemLapses({ title, problem }).some((l) => HARD.has(l));
}

const MAX_PLAIN = 400;

/**
 * The refuter's plain sentence, put above the judge's text when the judge
 * wrote none, never in place of it. Null when the sentence fails the same
 * bar it is meant to satisfy, or is too long to be the plain half.
 */
export function withPlainHalf(problem: string, plain: string, title: string, attribute?: string): string | null {
  const p = plain.trim();
  if (p === "" || p.length > MAX_PLAIN) return null;
  const composed = `${p}\n\n${problem.trim()}`;
  const lapses = problemLapses({ title, problem: composed, attribute });
  return lapses.some((l) => HARD.has(l) || l === "label-in-plain" || l === "plain-too-short") ? null : composed;
}
