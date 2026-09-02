/**
 * One ruling's record: the judge's account in one sentence, and the attempt
 * as state.json keeps it.
 *
 * Both channels rule the same way and write the same shape, and they used to
 * do it from two copies of the code. This is the one copy, so a fact added to
 * the record reaches both verify-fix and the source-scan ruling at once.
 */
import { loadState, saveState, type AttemptRecord } from "../fix/state.js";
import type { Verdict } from "../fix/rule.js";
import type { ResolvedConfig } from "../types.js";
import { nowIso } from "../util.js";

export interface JudgeNoteInput {
  nothingChanged: boolean;
  baselineShots: number;
  /** Every screenshot in the verify scope, changed or not. */
  totalShots: number;
  stillOpen: { observed: string }[];
  unmet: { text: string }[];
  unclosable: { route: string }[];
}

/**
 * What the judge still sees, as one sentence: the first thing that explains
 * why this attempt did not pass, from the cause that forecloses the others
 * (nothing was re-rendered) down to the one that only matters once every
 * other check is clean.
 */
export function judgeNoteFor(i: JudgeNoteInput): string {
  return i.nothingChanged
    ? i.baselineShots === 0
      ? `no baseline: none of the ${i.totalShots} screenshot(s) in this scope have a previous ` +
        "capture to compare against, so lookout cannot tell whether the fix reached the rendered " +
        "output. Run `lookout check` on this scope first, then verify."
      : `nothing changed: all ${i.baselineShots} comparable screenshot(s) in this scope are ` +
        "byte-identical to the previous run, so no edit reached the rendered output. Either the fix " +
        "was not applied, it was applied somewhere the app does not use, or the app was not rebuilt."
    : i.stillOpen.length > 0
      ? i.stillOpen[0]!.observed
      : i.unmet.length > 0
        ? `${i.unmet.length} acceptance criteri${i.unmet.length === 1 ? "on" : "a"} still fail: ` +
          i.unmet.map((c) => c.text).join("; ")
        : i.unclosable.length > 0
          ? `${i.unclosable.length} finding(s) sit on pixels unchanged since they were filed ` +
            `(${[...new Set(i.unclosable.map((m) => m.route))].join(", ")}); the judge not re-filing ` +
            "them is not evidence of a fix. If they were fixed earlier or are intended, adjudicate " +
            "them; otherwise the fix has not reached these views."
          : "";
}

export interface AttemptInput {
  n: number;
  commit?: string | null;
  note?: string | null;
  verdict: Verdict;
  judgeNote?: string;
  spawned?: string[];
}

/** The attempt as state.json keeps it: nothing absent is written as empty. */
export function attemptRecord(a: AttemptInput): AttemptRecord {
  return {
    n: a.n,
    dispatchedAt: nowIso(),
    ...(a.commit || a.note
      ? { reported: { ...(a.commit ? { commit: a.commit } : {}), ...(a.note ? { note: a.note } : {}) } }
      : {}),
    verdict: a.verdict,
    ...(a.judgeNote ? { judgeNote: a.judgeNote } : {}),
    ...(a.spawned && a.spawned.length > 0 ? { spawned: a.spawned } : {}),
  };
}

export async function recordAttempt(
  resolved: ResolvedConfig,
  issueId: string,
  attempt: AttemptRecord,
): Promise<void> {
  const state = await loadState(resolved, issueId);
  state.attempts.push(attempt);
  await saveState(resolved, state);
}
