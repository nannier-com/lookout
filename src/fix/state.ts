/**
 * Per-cluster attempt history, kept in the (gitignored) evidence directory
 * because it is working state, not adjudicated record. The durable trace of a
 * cluster's history lives on the backlog findings themselves: fixAttempts, and
 * the mandatory reason written when a cluster is finally blocked.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
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
}

export interface ClusterState {
  id: string;
  attempts: AttemptRecord[];
}

export function fixDir(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "fix");
}

export function statePath(resolved: ResolvedConfig, clusterId: string): string {
  return join(fixDir(resolved), `${clusterId}.state.json`);
}

export async function loadState(
  resolved: ResolvedConfig,
  clusterId: string,
): Promise<ClusterState> {
  const p = statePath(resolved, clusterId);
  if (!existsSync(p)) return { id: clusterId, attempts: [] };
  try {
    return JSON.parse(await readFile(p, "utf8")) as ClusterState;
  } catch {
    return { id: clusterId, attempts: [] };
  }
}

export async function saveState(resolved: ResolvedConfig, state: ClusterState): Promise<void> {
  const p = statePath(resolved, state.id);
  await mkdir(fixDir(resolved), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, p);
}
