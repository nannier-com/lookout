/**
 * Judge cache, keyed by VIEW GROUP rather than by single shot.
 *
 * The rubric asks the judge to compare a view's dark/light pair and its
 * form-factor progression (BASE.md, judging procedure steps 2 and 3). A
 * per-shot cache breaks that: after a fix changes only the light shot, the
 * dark partner would be served from cache and never enter the batch, so the
 * judge would be asked for a comparison with one side missing and would
 * silently stop filing it. A `verify-fix` would then read that silence as
 * "fixed". Grouping the cache the way the rubric groups the judgement is what
 * makes a scoped re-check trustworthy.
 *
 * A group is one target + platform + route + state, across every form factor
 * and scheme. Its key is `<groupHash>@v<version>@<model>`, where groupHash
 * covers every member's pixel hash, so any member changing re-judges the whole
 * group.
 *
 * Lives in .lookout/ledger.json (committed by projects that want cheap re-runs
 * across machines; harmless if ignored).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { lookoutDir } from "../config.js";
import { nowIso, sha256 } from "../util.js";
import type { AiFinding } from "./engine.js";

export interface LedgerEntry {
  verdict: "clean" | "findings";
  findings?: AiFinding[];
  /** Member shot ids, so a stale entry is readable when debugging. */
  shotIds: string[];
  judgedAt: string;
  runId: string;
}

export interface Ledger {
  note: string;
  entries: Record<string, LedgerEntry>;
}

const NOTE =
  "lookout judge cache. Key = <viewGroupHash>@v<judgeSkillVersion>@<model>, where a view group is one " +
  "target+platform+route+state across every form factor and scheme, so comparative findings never " +
  "cache apart. Delete entries (or bump the visual-judge skill version) to force fresh judging.";

export function ledgerPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "ledger.json");
}

/**
 * Hash of a whole view group: every member's pixel hash, sorted by shot id so
 * capture order cannot perturb it. One member changing changes the group hash.
 */
export function groupHash(shots: ShotRecord[]): string {
  const parts = shots
    .map((s) => `${s.id}@${s.hash}`)
    .sort()
    .join("\n");
  return sha256(new TextEncoder().encode(parts));
}

export function ledgerKey(hash: string, skillVersion: number, model: string): string {
  return `${hash}@v${skillVersion}@${model}`;
}

export async function loadLedger(resolved: ResolvedConfig): Promise<Ledger> {
  const p = ledgerPath(resolved);
  if (!existsSync(p)) return { note: NOTE, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as Ledger;
    return { note: NOTE, entries: parsed.entries ?? {} };
  } catch {
    return { note: NOTE, entries: {} };
  }
}

export async function saveLedger(resolved: ResolvedConfig, ledger: Ledger): Promise<void> {
  const p = ledgerPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, p);
}

/**
 * Record one entry per judged view group. Findings are stored whole: on a
 * cache hit the group's findings come back together, which is what keeps a
 * comparative finding attached to the view it was made about.
 */
export function recordVerdicts(
  ledger: Ledger,
  runId: string,
  skillVersion: number,
  model: string,
  judged: { shots: ShotRecord[]; findings: AiFinding[] }[],
): void {
  for (const { shots, findings } of judged) {
    if (shots.length === 0) continue;
    ledger.entries[ledgerKey(groupHash(shots), skillVersion, model)] = {
      verdict: findings.length === 0 ? "clean" : "findings",
      ...(findings.length > 0 ? { findings } : {}),
      shotIds: shots.map((s) => s.id).sort(),
      judgedAt: nowIso(),
      runId,
    };
  }
}
