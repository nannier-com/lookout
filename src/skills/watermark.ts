/**
 * The learned-from watermark: which signals an improve pass has already seen.
 *
 * Signals recompute from the backlog and the judge report on every gather, so
 * without this, the same by-design adjudication was a signal forever and
 * every improve re-paid for lessons already amended in. Consumption is the
 * decay: a signal is stamped seen when an improve RECORDS an outcome for it,
 * whatever the outcome. Rolled-back and no-change count on purpose: identical
 * evidence would produce the identical amendment and the identical rollback,
 * at model cost each time, so new learning requires new evidence.
 *
 * The file sits beside history.jsonl and is committed for the same reason the
 * amendment layers are: a fresh clone must not re-learn lessons its committed
 * amendments already encode.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import { nowIso } from "../util.js";
import type { ResolvedConfig } from "../types.js";
import type { Signal } from "./signals.js";

export interface Watermark {
  /** When an improve last ran to completion (any recorded action). */
  lastImproveAt: string | null;
  /** What it did, for the page and the summaries. */
  lastAction: string | null;
  /** Signal key -> when it was first shown to an improve pass. */
  seen: Record<string, string>;
}

export function seenPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "skills", "signals-seen.json");
}

export async function loadWatermark(resolved: ResolvedConfig): Promise<Watermark> {
  const p = seenPath(resolved);
  if (!existsSync(p)) return { lastImproveAt: null, lastAction: null, seen: {} };
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as Partial<Watermark>;
    return {
      lastImproveAt: raw.lastImproveAt ?? null,
      lastAction: raw.lastAction ?? null,
      seen: raw.seen ?? {},
    };
  } catch {
    // An unreadable watermark means everything counts as new: one bounded
    // re-improve beats silently never learning again.
    return { lastImproveAt: null, lastAction: null, seen: {} };
  }
}

/** The signals no improve pass has been shown yet. */
export function newSignals(mark: Watermark, signals: Signal[]): Signal[] {
  return signals.filter((s) => !(s.key in mark.seen));
}

/** Stamp every shown signal seen, and the pass itself done. */
export async function stampSeen(
  resolved: ResolvedConfig,
  mark: Watermark,
  shown: Signal[],
  action: string,
): Promise<void> {
  const at = nowIso();
  for (const s of shown) mark.seen[s.key] ??= at;
  mark.lastImproveAt = at;
  mark.lastAction = action;
  const p = seenPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(mark, null, 2) + "\n");
}
