/**
 * lookout's record of what it did to its own instructions.
 *
 * Every amendment lands here whether it was applied, rolled back, proposed or
 * declined, because the rollbacks are the interesting ones: an amendment the
 * frozen set killed is evidence the gate works, and a record that kept only the
 * successes would be a record of lookout marking its own homework.
 *
 * The lock sits beside it for the same reason it exists at all. Two improves at
 * once would restore each other's before-state and silently drop an amendment
 * that had already passed; and since neither writes its record until it has
 * finished deciding, the lock is also the only honest answer to "is lookout
 * changing itself right now", which is what the page reads.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import type { Drift, Violation } from "./verdict.js";
import type { ResolvedConfig } from "../types.js";

export const SKILL_NAMES = [
  "judge-core",
  "judge-integrity",
  "judge-geometry",
  "judge-visibility",
  "judge-text",
  "judge-craft",
  "judge-design-parity",
  "judge-taste",
  "refute-finding",
  "judge-challenge",
  "verify-acceptance",
  "fact-check",
  "design-placement",
  "kit-conformance",
  "map-screens",
  "plan-navigation",
  "improve-skills",
] as const;

export function historyPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "skills", "history.jsonl");
}

/**
 * Where `skills improve` says it is running.
 *
 * Beside the history, because both are lookout's record of what it did to its
 * own instructions: one says what happened, this one says it is happening.
 */
export function improveLockPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "skills", "improve.lock");
}

interface HistoryEntry {
  at: string;
  skill: string;
  action: "applied" | "rolled-back" | "proposed" | "no-change";
  summary: string;
  version?: number;
  evidence?: string[];
  violations?: Violation[];
  /**
   * What the gate saw besides its verdict. Kept because both are about the
   * frozen set rather than the amendment: drift is a panel relabelling a settled
   * claim, and a stale claim is one the unchanged skills no longer reproduce.
   * A record that kept only the verdict could not tell the two apart later.
   */
  drift?: Drift[];
  stale?: Violation[];
}

export async function record(resolved: ResolvedConfig, entry: HistoryEntry): Promise<void> {
  const p = historyPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n");
}

/** Judge the frozen set as the skills currently stand, and see what breaks. */
