/**
 * What the defect looked like, and what replaced it.
 *
 * The evidence store writes one file per view, at a path derived from the view
 * itself, so a re-capture overwrites the frame it is replacing. That is the
 * right behaviour for a store whose job is "what does this app render now", and
 * it means the moment `verify-fix` proves a defect gone, the pixels that proved
 * it existed are gone too. The card kept showing a strip labelled "where
 * lookout saw it" that was, by then, a picture of the fixed screen.
 *
 * So two frames per view are frozen out of the way. The BEFORE is taken just
 * before a ruling re-captures anything, and only once: later attempts on the
 * same issue keep the original, because the thing worth comparing against is
 * the defect as filed, not as it looked after somebody's first try at it. The
 * AFTER is taken when a ruling passes, which is the only moment lookout is
 * willing to say the screen is fixed.
 *
 * They live in the evidence store because that is what the ui serves and what
 * `/thumb/` resizes, and under a reserved `frozen/` prefix that no capture
 * writes into, so nothing overwrites them the way the store overwrites
 * everything else. A manifest beside them carries what each frame is a picture
 * of; parsing that back out of a flattened filename would be guessing.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { flatShotName } from "./paths.js";
import { wasPhotographed } from "../backlog/lib.js";
import { nowIso } from "../util.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig } from "../types.js";

/** Which side of the fix a frame is a picture of. */
export type FrameSide = "before" | "after";

export interface Frame {
  /** Evidence-relative, which is what the ui serves and thumbnails. */
  path: string;
  route: string;
  formFactor: string;
  scheme: string;
  state?: string;
  /** When this frame was frozen. */
  at: string;
}

export interface FrameSet {
  schema: 1;
  before: Frame[];
  after: Frame[];
}

const EMPTY: FrameSet = { schema: 1, before: [], after: [] };

/** `frozen/<id>`, evidence-relative: the prefix no capture writes into. */
export function framesRel(id: string): string {
  return join("frozen", id);
}

export function framesDir(resolved: ResolvedConfig, id: string): string {
  return join(evidenceDir(resolved), framesRel(id));
}

function manifestPath(resolved: ResolvedConfig, id: string): string {
  return join(framesDir(resolved, id), "frames.json");
}

/** The frames frozen for this issue, or an empty set. */
export async function loadFrames(resolved: ResolvedConfig, id: string): Promise<FrameSet> {
  const p = manifestPath(resolved, id);
  if (!existsSync(p)) return EMPTY;
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as FrameSet;
    if (raw?.schema !== 1) return EMPTY;
    return { schema: 1, before: raw.before ?? [], after: raw.after ?? [] };
  } catch {
    return EMPTY;
  }
}

async function saveFrames(
  resolved: ResolvedConfig,
  id: string,
  set: FrameSet,
): Promise<void> {
  await mkdir(framesDir(resolved, id), { recursive: true });
  await writeFile(manifestPath(resolved, id), JSON.stringify(set, null, 2) + "\n");
}

/**
 * Copy this issue's current frames aside as one side of the comparison.
 *
 * `before` is written once and then left alone: an issue re-verified three
 * times still shows the defect as it was filed. `after` is rewritten every time
 * it is taken, because the only thing worth keeping there is the frame that
 * actually cleared the issue.
 *
 * Returns what was frozen, which is empty when there was nothing to copy: a
 * code-channel issue has no screenshots at all, and a frame whose file has been
 * cleaned out of the evidence store cannot be frozen after the fact.
 */
export async function freezeFrames(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  side: FrameSide,
): Promise<Frame[]> {
  const existing = await loadFrames(resolved, cluster.id);
  if (side === "before" && existing.before.length > 0) return existing.before;

  const evDir = evidenceDir(resolved);
  const dir = join(framesDir(resolved, cluster.id), side);
  const frames: Frame[] = [];
  const seen = new Set<string>();
  const at = nowIso();

  for (const m of cluster.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || !wasPhotographed(m) || seen.has(ev.path)) continue;
    const src = join(evDir, ev.path);
    if (!existsSync(src)) continue;
    seen.add(ev.path);
    const file = flatShotName(ev.path);
    await mkdir(dir, { recursive: true });
    try {
      await copyFile(src, join(dir, file));
    } catch {
      // A frame that cannot be copied is one fewer picture, not a failed
      // ruling. The verdict does not depend on any of this.
      continue;
    }
    frames.push({
      path: join(framesRel(cluster.id), side, file),
      route: m.route,
      formFactor: m.formFactor ?? "",
      scheme: m.scheme ?? "",
      ...(m.state ? { state: m.state } : {}),
      at,
    });
  }

  if (frames.length === 0) return [];
  await saveFrames(resolved, cluster.id, { ...existing, schema: 1, [side]: frames });
  return frames;
}
