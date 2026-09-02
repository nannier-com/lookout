/**
 * Per-issue attempt history, kept in the issue's own folder.
 *
 * It used to live under the gitignored evidence directory on the grounds that
 * it is working state rather than adjudicated record. Numbering the issues gave
 * it a better home: everything about issue 418203 belongs in 418203's folder,
 * and the history of what was tried survives an evidence clean now that it does
 * not sit inside one. The adjudicated trace still lives on the findings
 * themselves: fixAttempts, and the mandatory reason written when an issue is
 * finally blocked.
 *
 * Unlike Issue.json and Issue.md beside it, this file is NOT generated. Nothing
 * rewrites it from the backlog, because nothing else remembers what was tried.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { issueDir } from "../issues/paths.js";
import type { ResolvedConfig } from "../types.js";

export type { Verdict } from "./rule.js";
import type { Verdict } from "./rule.js";

/**
 * What lookout saw in the repository when it ruled: facts it observed, kept
 * apart from `reported` so a fixer's claim is never filed as lookout's own.
 * Absent entirely when the project is not a git checkout.
 */
export interface RepoObservation {
  head?: string;
  /** Uncommitted changes at ruling time, `.lookout/` excluded. */
  dirty?: boolean;
  dirtyFiles?: string[];
  /** Files changed between the previous attempt's commit and this one's. */
  filesChanged?: string[];
}

export interface AttemptRecord {
  n: number;
  dispatchedAt: string;
  /** What the person or tool that made the change reported. */
  reported?: { commit?: string; note?: string };
  verdict?: Verdict;
  /** What the judge still saw when this attempt was ruled on. */
  judgeNote?: string;
  /**
   * Issues this attempt surfaced elsewhere, by id. History, not blame: this
   * issue is not reopened, regressed or charged an attempt for them.
   */
  spawned?: string[];
  /** The run that captured and judged for this ruling. */
  runId?: string;
  /** The pixels-moved guard's inputs: what was compared, and how much moved. */
  totalShots?: number;
  changedShots?: number;
  baselineShots?: number;
  /** Every finding still filed against the issue after this ruling, with the judge's account. */
  stillOpen?: { title: string; shotId: string; observed: string }[];
  /** Routes whose pixels did not move since filing, so nothing on them could close. */
  unclosable?: string[];
  /**
   * The criteria as this ruling left them. The issue's own list is overwritten
   * by the next ruling; this is the only place attempt 1's verdicts survive
   * attempt 2.
   */
  criteria?: { id: string; text: string; verdict: string; note?: string }[];
  /** The contact sheet of this ruling's capture, absolute. */
  contactSheet?: string;
  /** The flags that narrowed this ruling's capture or judging, when any did. */
  flags?: Record<string, string | boolean>;
  observed?: RepoObservation;
  /** What this ruling's screenshots were compared against. */
  baseline?: { kind: "ruling" | "frozen" | "report"; runId?: string; at?: string };
}

/**
 * The capture the next ruling is measured against: every shot of the last
 * ruling, by hash. Anchored here rather than in the workspace because the
 * workspace moves with every capture, including a `check` run between the
 * edit and the ruling, which used to leave a real fix reading as no change.
 */
export interface RulingBaseline {
  runId: string;
  capturedAt: string;
  hashes: Record<string, string>;
}

export interface ClusterState {
  id: string;
  attempts: AttemptRecord[];
  baseline?: RulingBaseline;
}

export function statePath(resolved: ResolvedConfig, issueId: string): string {
  return join(issueDir(resolved, issueId), "state.json");
}

export async function loadState(
  resolved: ResolvedConfig,
  issueId: string,
): Promise<ClusterState> {
  const p = statePath(resolved, issueId);
  if (!existsSync(p)) return { id: issueId, attempts: [] };
  try {
    return JSON.parse(await readFile(p, "utf8")) as ClusterState;
  } catch {
    return { id: issueId, attempts: [] };
  }
}

export async function saveState(resolved: ResolvedConfig, state: ClusterState): Promise<void> {
  const p = statePath(resolved, state.id);
  await mkdir(issueDir(resolved, state.id), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, p);
}
