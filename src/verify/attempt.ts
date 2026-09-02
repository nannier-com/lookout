/**
 * One ruling's record: the judge's account in one sentence, what lookout
 * observed in the repository, and the attempt as state.json keeps it.
 *
 * Both channels rule the same way and write the same shape, and they used to
 * do it from two copies of the code. This is the one copy, so a fact added to
 * the record reaches both verify-fix and the source-scan ruling at once.
 */
import { loadState, saveState, type AttemptRecord, type RepoObservation, type RulingBaseline } from "../fix/state.js";
import { rulingBaselineOf } from "./baseline.js";
import { movesRecorded, type ShotMove } from "./moved.js";
import type { PixelDiff } from "./pixels.js";
import type { Verdict } from "../fix/rule.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { execFileAsync, nowIso } from "../util.js";

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
        "identical pixel for pixel to the previous run, so no edit reached the rendered output. " +
        "Either the fix was not applied, it was applied somewhere the app does not use, or the app " +
        "was not rebuilt."
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

const MAX_STILL_OPEN = 10;
const MAX_DIRTY = 20;
const MAX_CHANGED = 40;

/** The flags that narrow a ruling's capture or judging, out of everything parsed. */
const NARROWING = ["viewports", "schemes", "settle", "axe", "axe-contrast", "no-cache", "no-verify", "no-capture", "no-states", "panels"];

export function narrowingFlags(flags: Record<string, string | boolean>): Record<string, string | boolean> | undefined {
  const out: Record<string, string | boolean> = {};
  for (const k of NARROWING) if (flags[k] !== undefined) out[k] = flags[k]!;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** HEAD of the target repository, when it is a git checkout. */
export async function headSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What git says about the repository at ruling time. A claim in `--note` is
 * the fixer's; this is lookout's own observation, and it answers the two
 * questions a second attempt asks first: was anything committed, and did the
 * change land in the files the fix was meant to touch. `.lookout/` is left
 * out of the dirty list, because the ruling itself is what writes there.
 * Undefined when the project is not a git checkout.
 */
export async function observeRepo(
  cwd: string,
  previousCommit?: string | null,
  commit?: string | null,
): Promise<RepoObservation | undefined> {
  const git = async (args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd })).stdout;
  let head: string | undefined;
  try {
    head = (await git(["rev-parse", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
  const out: RepoObservation = head ? { head } : {};
  try {
    const lines = (await git(["status", "--porcelain"]))
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim())
      .filter((p) => !p.startsWith(".lookout/"));
    out.dirty = lines.length > 0;
    if (lines.length > 0) out.dirtyFiles = lines.slice(0, MAX_DIRTY);
  } catch {
    // Not knowing is not the same as clean, so `dirty` is simply absent.
  }
  if (previousCommit && commit && previousCommit !== commit) {
    try {
      const names = (await git(["diff", "--name-only", `${previousCommit}..${commit}`]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      out.filesChanged = names.slice(0, MAX_CHANGED);
    } catch {
      // A commit git cannot see (rebased away, or from another checkout) leaves this absent.
    }
  }
  return out;
}

export interface AttemptInput {
  n: number;
  commit?: string | null;
  note?: string | null;
  verdict: Verdict;
  judgeNote?: string;
  spawned?: string[];
  runId?: string;
  totalShots?: number;
  changedShots?: number;
  baselineShots?: number;
  moved?: ShotMove[];
  stillOpen?: { title: string; shotId: string; observed: string }[];
  unclosable?: string[];
  criteria?: { id: string; text: string; verdict: string; note?: string }[];
  contactSheet?: string | null;
  flags?: Record<string, string | boolean>;
  observed?: RepoObservation;
  baseline?: AttemptRecord["baseline"];
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
    ...(a.runId ? { runId: a.runId } : {}),
    ...(a.totalShots !== undefined ? { totalShots: a.totalShots } : {}),
    ...(a.changedShots !== undefined ? { changedShots: a.changedShots } : {}),
    ...(a.baselineShots !== undefined ? { baselineShots: a.baselineShots } : {}),
    ...(a.moved && a.moved.length > 0 ? { moved: a.moved } : {}),
    ...(a.stillOpen && a.stillOpen.length > 0 ? { stillOpen: a.stillOpen.slice(0, MAX_STILL_OPEN) } : {}),
    ...(a.unclosable && a.unclosable.length > 0 ? { unclosable: a.unclosable } : {}),
    ...(a.criteria && a.criteria.length > 0 ? { criteria: a.criteria } : {}),
    ...(a.contactSheet ? { contactSheet: a.contactSheet } : {}),
    ...(a.flags ? { flags: a.flags } : {}),
    ...(a.observed ? { observed: a.observed } : {}),
    ...(a.baseline ? { baseline: a.baseline } : {}),
  };
}

/**
 * One ruling, recorded: what the repository looked like, the attempt itself,
 * and this capture becoming the baseline the next ruling is measured against.
 *
 * Assembled here rather than in the verb, because both the shape of the record
 * and the order of the writes are facts about the record, not about the
 * command. The two derived lists come back out because the outcome report
 * prints the same ones.
 */
export async function recordRuling(a: {
  resolved: ResolvedConfig;
  issueId: string;
  n: number;
  commit?: string | null;
  note?: string | null;
  verdict: Verdict;
  judgeNote: string;
  spawned: string[];
  runId: string;
  shotsById: ReadonlyMap<string, ShotRecord>;
  changedShots: ReadonlySet<string>;
  baselineShots: number;
  /** How far each changed shot moved, for the shots that could be measured. */
  changes: ReadonlyMap<string, PixelDiff>;
  stillOpen: { title: string; observed: string; evidence: { shotId: string }[] }[];
  unclosable: { route: string }[];
  criteria: { id: string; text: string; verdict: string; note?: string }[];
  contactSheet: string | null;
  flags: Record<string, string | boolean>;
  baseline: AttemptRecord["baseline"];
}): Promise<{
  stillOpen: { title: string; shotId: string; observed: string }[];
  unclosable: string[];
  observed?: RepoObservation;
}> {
  const previous = await previousAttempt(a.resolved, a.issueId);
  const observed = await observeRepo(a.resolved.projectDir, previous?.reported?.commit, a.commit);
  const stillOpen = a.stillOpen.map((f) => ({
    title: f.title,
    shotId: f.evidence[0]?.shotId ?? "",
    observed: f.observed,
  }));
  const unclosable = [...new Set(a.unclosable.map((m) => m.route))];
  await recordAttempt(
    a.resolved,
    a.issueId,
    attemptRecord({
      n: a.n,
      commit: a.commit,
      note: a.note,
      verdict: a.verdict,
      judgeNote: a.judgeNote,
      spawned: a.spawned,
      runId: a.runId,
      totalShots: a.shotsById.size,
      changedShots: a.changedShots.size,
      baselineShots: a.baselineShots,
      moved: movesRecorded(a.changes),
      stillOpen,
      unclosable,
      criteria: a.criteria.map((c) => ({ id: c.id, text: c.text, verdict: c.verdict, ...(c.note ? { note: c.note } : {}) })),
      contactSheet: a.contactSheet,
      flags: narrowingFlags(a.flags),
      observed,
      baseline: a.baseline,
    }),
    rulingBaselineOf(a.shotsById),
  );
  return { stillOpen, unclosable, ...(observed ? { observed } : {}) };
}

/** The last attempt recorded for an issue, for what the next one is measured against. */
export async function previousAttempt(resolved: ResolvedConfig, issueId: string): Promise<AttemptRecord | undefined> {
  const state = await loadState(resolved, issueId);
  return state.attempts[state.attempts.length - 1];
}

/**
 * Write the attempt, and when the ruling captured anything, make its capture
 * the baseline the next ruling is measured against.
 */
export async function recordAttempt(
  resolved: ResolvedConfig,
  issueId: string,
  attempt: AttemptRecord,
  baseline?: RulingBaseline,
): Promise<void> {
  const state = await loadState(resolved, issueId);
  state.attempts.push(attempt);
  if (baseline) state.baseline = baseline;
  await saveState(resolved, state);
}
