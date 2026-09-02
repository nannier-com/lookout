/**
 * Which screenshots moved, and by how much.
 *
 * The guard that nothing may pass on unchanged pixels was a hash comparison,
 * and a hash answers only yes or no. These two steps keep that answer exactly
 * as strict and add a magnitude to it:
 *
 * - a shot with no baseline hash is evidence of nothing, and is neither
 *   changed nor comparable, which is what once let a cleaned evidence
 *   directory satisfy the guard;
 * - a shot whose hash matches did not move, and is never decoded;
 * - a shot whose hash differs did move, unless its baseline pixels are on hand
 *   and decode to exactly the same image. That last case is not pedantry: a
 *   Chromium upgrade between filing and ruling re-encodes identical pixels to
 *   different bytes, and the hash alone would call that a fix.
 *
 * The baseline pixels have to be read before the ruling's capture runs,
 * because capture writes each view back to the path it came from.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changeSaid, diffPng, type PixelDiff } from "./pixels.js";
import type { ShotRecord } from "../types.js";

/**
 * Everything held in memory across the capture. A ruling's scope is a handful
 * of routes, and PNG bytes are compressed, so this is megabytes; the cap is
 * there so an unusually wide scope degrades to "changed, not measured" rather
 * than to an out-of-memory failure.
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** The baseline's pixels, read before the capture writes over them. */
export async function snapshotBaseline(
  pixels: ReadonlyMap<string, string>,
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  let held = 0;
  for (const [id, file] of pixels) {
    if (held >= MAX_SNAPSHOT_BYTES) break;
    try {
      const bytes = await readFile(file);
      held += bytes.byteLength;
      out.set(id, bytes);
    } catch {
      // A baseline file that is gone leaves the shot unmeasured, never unchanged.
    }
  }
  return out;
}

/**
 * Compare each shot whose hash moved against the pixels kept for it. Run one
 * at a time: a full-page shot decodes to tens of megabytes raw, and the whole
 * scope in flight at once would hold all of them.
 */
export async function measureMoves(args: {
  shots: Iterable<ShotRecord>;
  priorHashes: ReadonlyMap<string, string>;
  before: ReadonlyMap<string, Buffer>;
  evidenceDir: string;
}): Promise<Map<string, PixelDiff>> {
  const out = new Map<string, PixelDiff>();
  for (const shot of args.shots) {
    const prior = args.priorHashes.get(shot.id);
    if (prior === undefined || prior === shot.hash) continue;
    const bytes = args.before.get(shot.id);
    if (!bytes) continue;
    const d = await diffPng(bytes, join(args.evidenceDir, shot.path));
    if (d) out.set(shot.id, d);
  }
  return out;
}

export interface ShotVerdicts {
  /** Shots whose pixels moved since the previous run. */
  changedShots: Set<string>;
  /** How many shots had a baseline to compare against at all. */
  baselineShots: number;
  /** Shots whose move was measured, by id. Absent means moved but unmeasured. */
  changes: Map<string, PixelDiff>;
}

/**
 * The per-shot decision, pure. A measurement can only ever move a shot from
 * changed to unchanged, and only by proving the two images are identical, so
 * this is never weaker than the hash comparison it replaces.
 */
export function classifyShots(args: {
  shots: readonly Pick<ShotRecord, "id" | "hash">[];
  priorHashes: ReadonlyMap<string, string>;
  measured: ReadonlyMap<string, PixelDiff>;
}): ShotVerdicts {
  const changedShots = new Set<string>();
  const changes = new Map<string, PixelDiff>();
  let baselineShots = 0;
  for (const shot of args.shots) {
    const prior = args.priorHashes.get(shot.id);
    if (prior === undefined) continue;
    baselineShots++;
    if (prior === shot.hash) continue;
    const d = args.measured.get(shot.id);
    if (d && d.changed === 0) continue;
    changedShots.add(shot.id);
    if (d) changes.set(shot.id, d);
  }
  return { changedShots, baselineShots, changes };
}

/** One shot's move, as the record and the report both keep it. */
export interface ShotMove {
  shotId: string;
  /** Pixels that differ, and out of how many. */
  changed: number;
  total: number;
  fraction: number;
  /** The same thing in the words the ruling prints. */
  said: string;
  /** Present only when the two captures are not the same size. */
  sizeChanged?: true;
}

/** At most this many moves are kept: a ruling names the largest, not every one. */
export const MAX_MOVES = 8;

/** The moves worth writing down, largest first. */
export function movesRecorded(changes: ReadonlyMap<string, PixelDiff>, cap = MAX_MOVES): ShotMove[] {
  return [...changes.entries()]
    .sort((a, b) => b[1].fraction - a[1].fraction)
    .slice(0, cap)
    .map(([shotId, d]) => ({
      shotId,
      changed: d.changed,
      total: d.total,
      fraction: Number(d.fraction.toFixed(6)),
      said: changeSaid(d),
      ...(d.sizeChanged ? { sizeChanged: true as const } : {}),
    }));
}
