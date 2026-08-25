/**
 * Judge cache: a shot judged under a given rubric version and model is never
 * judged again while its pixels are unchanged. Keyed `<hash>@r<version>@<model>`.
 * Lives in .lookout/ledger.json (committed by projects that want cheap re-runs
 * across machines; harmless if ignored).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "../types.js";
import { lookoutDir } from "../config.js";
import { nowIso } from "../util.js";
import type { AiFinding } from "./engine.js";

export interface LedgerEntry {
  verdict: "clean" | "findings";
  findings?: AiFinding[];
  judgedAt: string;
  runId: string;
}

export interface Ledger {
  note: string;
  entries: Record<string, LedgerEntry>;
}

const NOTE =
  "lookout judge cache. Key = <shotHash>@r<rubricVersion>@<model>. Delete entries (or bump the rubric version) to force fresh judging.";

export function ledgerPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "ledger.json");
}

export function ledgerKey(hash: string, rubricVersion: number, model: string): string {
  return `${hash}@r${rubricVersion}@${model}`;
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

export function recordVerdicts(
  ledger: Ledger,
  runId: string,
  rubricVersion: number,
  model: string,
  perShot: Map<string, { hash: string; findings: AiFinding[] }>,
): void {
  for (const { hash, findings } of perShot.values()) {
    ledger.entries[ledgerKey(hash, rubricVersion, model)] = {
      verdict: findings.length === 0 ? "clean" : "findings",
      ...(findings.length > 0 ? { findings } : {}),
      judgedAt: nowIso(),
      runId,
    };
  }
}
