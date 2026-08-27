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
}

export interface ClusterState {
  id: string;
  attempts: AttemptRecord[];
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
