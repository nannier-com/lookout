/**
 * What the defect looked like, and what replaced it.
 *
 * The capture workspace writes one file per view, at a path derived from the
 * view itself, so a re-capture overwrites the frame it is replacing. That is
 * the right behaviour for a workspace whose job is "what does this app render
 * now", and it means the moment `verify-fix` proves a defect gone, the pixels
 * that proved it existed are gone too.
 *
 * So two frames per view live in the issue's own folder, which is the durable
 * record of the defect. `img/pre/` is the defect as filed, and each view's
 * frame is written only once: later attempts on the same issue keep the
 * original, because the thing worth comparing against is the defect as filed,
 * not as it looked after somebody's first try at it. `img/post/` is the same
 * views once a ruling passed, which is the only moment lookout is willing to
 * say the screen is fixed, and it is rewritten whole each time one does.
 * `frames.json` beside them carries what each frame is a picture of; parsing
 * that back out of a flattened filename would be guessing. None of this is a
 * projection of anything: the workspace is routinely cleaned and rebuilt, and
 * these files are the only copy of the defect anybody keeps.
 *
 * Filing time is the earliest moment the pixels are guaranteed to be the
 * defect's, and it is why `ensureBeforeFrames` runs from every backlog save
 * rather than from `verify-fix` alone. An issue nobody ever asks lookout to
 * verify used to reach the board with no before frame at all, and the card
 * fell back to the live store, which the next `check` had already overwritten.
 *
 * Issues filed before the workspace left the project kept these frames in
 * `.lookout/evidence/fix-frames/`; the first load after the move folds them
 * into the folder, because they are irreplaceable and everything else in that
 * old store is not.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { evidenceDir, lookoutDir } from "../config.js";
import { flatShotName, issueDir } from "./paths.js";
import { wasPhotographed } from "../backlog/lib.js";
import { nowIso } from "../util.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig } from "../types.js";

/** Which side of the fix a frame is a picture of. */
export type FrameSide = "before" | "after";

/** The folder a side's frames sit in, named the way the dossier names them. */
const SIDE_DIR: Record<FrameSide, string> = { before: "pre", after: "post" };

export interface Frame {
  /** Relative to the issue's folder, e.g. `img/pre/web-app-root--dark.png`. */
  path: string;
  route: string;
  /** "web", or the device platform. Absent on frames frozen before devices were recorded. */
  platform?: string;
  formFactor: string;
  scheme: string;
  state?: string;
  /** When this frame was frozen. */
  at: string;
  /**
   * The shot this is a copy of, and the hash of its pixels at freeze time.
   * What lets a never-ruled issue be verified against the defect as filed
   * rather than against whatever the workspace holds now. Absent on frames
   * frozen before these were recorded; both are recovered from the file.
   */
  shotId?: string;
  hash?: string;
}

export interface FrameSet {
  schema: 2;
  before: Frame[];
  after: Frame[];
}

const EMPTY: FrameSet = { schema: 2, before: [], after: [] };

function manifestPath(resolved: ResolvedConfig, id: string): string {
  return join(issueDir(resolved, id), "frames.json");
}

/** Where this frame is on disk, wherever the issue's folder is right now. */
export function frameAbsPath(resolved: ResolvedConfig, id: string, f: Frame): string {
  return join(issueDir(resolved, id), f.path);
}

/**
 * The frame in the two path forms the page needs: `path` relative to the
 * project's `.lookout/` (which is how the ui's routes serve it, `issues/...`
 * distinguishing it from a workspace shot), and `absPath` for whoever wants
 * the file itself.
 */
export function frameServedPath(
  resolved: ResolvedConfig,
  id: string,
  f: Frame,
): { path: string; absPath: string } {
  const absPath = frameAbsPath(resolved, id, f);
  const path = relative(lookoutDir(resolved), absPath).split(sep).join("/");
  return { path, absPath };
}

/** The frames kept for this issue, or an empty set. */
export async function loadFrames(resolved: ResolvedConfig, id: string): Promise<FrameSet> {
  const p = manifestPath(resolved, id);
  if (!existsSync(p)) {
    return (await adoptStoreFrames(resolved, id)) ?? EMPTY;
  }
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as FrameSet;
    if (raw?.schema !== 2) return EMPTY;
    return { schema: 2, before: raw.before ?? [], after: raw.after ?? [] };
  } catch {
    return EMPTY;
  }
}

async function saveFrames(resolved: ResolvedConfig, id: string, set: FrameSet): Promise<void> {
  await mkdir(issueDir(resolved, id), { recursive: true });
  await writeFile(manifestPath(resolved, id), JSON.stringify(set, null, 2) + "\n");
}

/**
 * Fold in frames an older lookout froze into the project's evidence store.
 *
 * The store under `.lookout/evidence/` is not written any more, but the
 * frames in it are the only picture of a defect as it was filed, so the first
 * read adopts them instead of letting them go stale with the rest. The
 * dossier already holds a faithful copy of every frozen frame under `img/`
 * (the old save kept them in sync), so mostly this writes the manifest; a
 * copy that never landed is taken from the old store while it is still there.
 */
async function adoptStoreFrames(resolved: ResolvedConfig, id: string): Promise<FrameSet | null> {
  const storeDir = join(lookoutDir(resolved), "evidence");
  const legacyManifest = join(storeDir, "fix-frames", id, "frames.json");
  if (!existsSync(legacyManifest)) return null;
  interface LegacyFrame {
    path: string;
    route: string;
    formFactor: string;
    scheme: string;
    state?: string;
    at?: string;
  }
  let raw: { schema?: number; before?: LegacyFrame[]; after?: LegacyFrame[] };
  try {
    raw = JSON.parse(await readFile(legacyManifest, "utf8")) as typeof raw;
  } catch {
    return null;
  }
  if (raw?.schema !== 1) return null;

  const set: FrameSet = { schema: 2, before: [], after: [] };
  for (const side of ["before", "after"] as const) {
    for (const f of raw[side] ?? []) {
      const file = f.path.split(/[\\/]/).pop()!;
      const rel = join("img", SIDE_DIR[side], file);
      const dest = join(issueDir(resolved, id), rel);
      if (!existsSync(dest)) {
        const src = join(storeDir, f.path);
        if (!existsSync(src)) continue;
        await mkdir(join(dest, ".."), { recursive: true });
        await copyFile(src, dest).catch(() => {});
        if (!existsSync(dest)) continue;
      }
      set[side].push({
        path: rel,
        route: f.route,
        formFactor: f.formFactor,
        scheme: f.scheme,
        ...(f.state ? { state: f.state } : {}),
        at: f.at ?? nowIso(),
      });
    }
  }
  await saveFrames(resolved, id, set);
  return set;
}

/**
 * Freeze this issue's current workspace views as one side of the comparison.
 *
 * `before` is written once PER VIEW. A view already frozen keeps the pixels it
 * was filed against, so an issue re-verified three times still shows the defect
 * as filed rather than as the last attempt left it; a view the cluster only
 * gained later is frozen now, at the save that filed the finding on it, which
 * is that view's own filing moment. Freezing once per ISSUE instead would leave
 * every later view with no picture at all, and the card draws what is frozen.
 *
 * `after` is rewritten whole every time it is taken, because the only thing
 * worth keeping there is the frame that actually cleared the issue.
 *
 * Returns the side as it now stands, which is empty when there was nothing to
 * copy: a code-channel issue has no screenshots at all, and a frame whose file
 * has been cleaned out of the workspace cannot be frozen after the fact.
 */
export async function freezeFrames(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  side: FrameSide,
): Promise<Frame[]> {
  const existing = await loadFrames(resolved, cluster.id);
  const kept = side === "before" ? existing.before : [];
  const frozen = new Set(kept.map((f) => f.path));

  const evDir = evidenceDir(resolved);
  const dir = join(issueDir(resolved, cluster.id), "img", SIDE_DIR[side]);
  const frames: Frame[] = [];
  const seen = new Set<string>();
  const at = nowIso();

  for (const m of cluster.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || !wasPhotographed(m) || seen.has(ev.path)) continue;
    const file = flatShotName(ev.path);
    const rel = join("img", SIDE_DIR[side], file);
    if (frozen.has(rel)) continue;
    const src = join(evDir, ev.path);
    if (!existsSync(src)) continue;
    seen.add(ev.path);
    await mkdir(dir, { recursive: true });
    try {
      await copyFile(src, join(dir, file));
    } catch {
      // A frame that cannot be copied is one fewer picture, not a failed
      // ruling. The verdict does not depend on any of this.
      continue;
    }
    frames.push({
      path: rel,
      route: m.route,
      ...(m.platform ? { platform: m.platform } : {}),
      formFactor: m.formFactor ?? "",
      scheme: m.scheme ?? "",
      ...(m.state ? { state: m.state } : {}),
      at,
      shotId: ev.shotId,
      hash: ev.hash,
    });
  }

  if (frames.length === 0) return kept;
  const merged = [...kept, ...frames];
  await saveFrames(resolved, cluster.id, { ...existing, schema: 2, [side]: merged });
  return merged;
}

/**
 * The pre-fix frames for this issue, frozen now if nothing has frozen them yet.
 *
 * Called from every backlog save, which is what makes "every issue has a
 * picture of its own defect" a property of the system rather than a thing
 * `verify-fix` happens to do on its way past. A save runs after the capture the
 * findings were judged from, so the files it copies are the defect's own
 * pixels, and it is a no-op from the second save onwards.
 *
 * One case is skipped, and only one: an issue that has nothing frozen at all
 * AND has already spent a fix attempt. That is the retroactive case, an issue
 * filed before lookout froze anything, and its frames in the workspace are of
 * unknown vintage, because something has claimed to change that screen since.
 * Copying them now would file a picture of somebody's fix under a label saying
 * "the defect". Those issues report no pre-fix frame, which is true, and
 * `backlog check` lists them.
 *
 * An issue that IS frozen keeps taking new views as it gains them, whatever it
 * has spent, because a view's first frame is the pixels its own finding was
 * filed against however late in the issue's life that finding arrived.
 */
export async function ensureBeforeFrames(
  resolved: ResolvedConfig,
  cluster: FixCluster,
): Promise<FrameSet> {
  const existing = await loadFrames(resolved, cluster.id);
  if (existing.before.length === 0 && cluster.attemptsSpent > 0) return existing;
  const before = await freezeFrames(resolved, cluster, "before");
  return before.length > 0 ? { ...existing, before } : existing;
}
