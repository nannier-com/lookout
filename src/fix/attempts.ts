/**
 * What lookout says about one attempt, in the sentences it has always used.
 *
 * The board's record feed and the issue document both narrate the same
 * attempts, and they must say the same thing about each: a fixer who reads one
 * and then the other should recognise every line. So the sentences live here,
 * once, and both surfaces print them.
 */
import type { AttemptRecord } from "./state.js";

export interface AttemptSentences {
  /** "a fix was reported at <commit>: <note>", when anything was reported. */
  claimed?: string;
  /** "fixing this surfaced issue <id>", when the attempt surfaced any. */
  surfaced?: string;
  /** "lookout ruled it <verdict>: <judge note>", once ruled. */
  verdict?: string;
}

export function attemptSentences(a: AttemptRecord): AttemptSentences {
  const out: AttemptSentences = {};
  if (a.reported?.commit || a.reported?.note) {
    out.claimed =
      "a fix was reported" +
      (a.reported.commit ? ` at ${a.reported.commit}` : "") +
      (a.reported.note ? `: ${a.reported.note}` : "");
  }
  // What the fix surfaced elsewhere, said plainly and without blame: these are
  // their own issues, and this one is not answerable for them.
  if (a.spawned && a.spawned.length > 0) {
    out.surfaced =
      a.spawned.length === 1
        ? `fixing this surfaced issue ${a.spawned[0]}`
        : `fixing this surfaced issues ${a.spawned.join(", ")}`;
  }
  if (a.verdict) {
    out.verdict = `lookout ruled it ${a.verdict}` + (a.judgeNote ? `: ${a.judgeNote}` : "");
  }
  return out;
}
