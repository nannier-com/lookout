/**
 * Throwing away what lookout has collected about a project.
 *
 * Two sizes of the same act, both reached from the page and neither from a verb:
 * clearing the judge's transcript, and resetting the project outright.
 *
 * The reason this is a module rather than two lines in a route is that neither
 * act is one store. What the page shows is assembled from three, and a reset
 * that reaches only one of them leaves the page looking exactly as stale as it
 * did before:
 *
 *  - the FILES under the project's `.lookout/`: the backlog, the issue folders
 *    and their frozen pixels, the capture workspace, the event log, and the
 *    narration this rail reads;
 *  - the SERVER's caches over those files: the status body cached in
 *    `payload.ts` and the narration cursor in `narration.ts`, neither of which
 *    re-reads a file it has already answered from;
 *  - the SERVER's current queue cache, which must be cleared when its backing
 *    file is deleted.
 *
 * That third one is the trap. Deleting `.lookout/` by hand is exactly what a
 * reader would try first, and it leaves the header still counting a run whose
 * files are gone.
 */
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lookoutDir } from "../config.js";
import { narrationPath } from "../report/narration.js";
import { forgetNarration } from "./narration.js";
import { forgetBoard } from "./payload.js";
import { withProjectLock, withStateLock } from "../state/lock.js";
import { checkIsRunning, session } from "./session.js";
import type { ResolvedConfig } from "../types.js";

/**
 * What survives a reset.
 *
 * `ui.json` is the page's own settings, not a finding: which project it is
 * pointed at, the base URL override, the navigation consent. Wiping the record
 * and being asked to choose the folder again is two acts, and only one of them
 * was asked for.
 */
const KEEP = new Set(["ui.json", "locks"]);

/**
 * Empty the judge's transcript.
 *
 * Truncated rather than deleted, because a run in flight holds this path and
 * goes on appending to it; unlinking underneath a writer would send the rest of
 * the run's narration to a file nothing reads. Emptying it leaves that writer
 * correct and the reader with nothing to show, which is the ask.
 *
 * `forgetNarration` is the other half. The cursor is what makes the rail
 * incremental, and a cursor pointing past the end of a file that just became
 * empty would keep every open page showing what was cleared until the next run
 * happened to shorten the file again.
 */
export async function clearNarration(resolved: ResolvedConfig): Promise<void> {
  const path = narrationPath(resolved);
  if (existsSync(path)) {
    try {
      await writeFile(path, "");
    } catch {
      // Best effort, matching the writer: a workspace that cannot be written to
      // must not take the page down. The cursor reset below still empties the
      // rail, so the press does something even here.
    }
  }
  forgetNarration();
}

/** Whether the reset happened, and what it took with it. */
export interface ResetOutcome {
  ok: boolean;
  /** Why it was refused, when it was. */
  why?: string;
  /** The entries removed from `.lookout/`, for the answer the page reports. */
  removed: string[];
}

/**
 * Reset the project: delete the record, and forget it here too.
 *
 * Refused while a run is in flight. A check writes screenshots, events and
 * narration continuously, so deleting the directory underneath one would race
 * the writer and leave a half-rebuilt workspace that looks like a fresh capture
 * without being one. Stopping the run first is a decision the operator should
 * make deliberately, not one this hides inside a wipe.
 */
export async function resetProject(resolved: ResolvedConfig): Promise<ResetOutcome> {
  if (checkIsRunning(resolved)) {
    return { ok: false, why: "a run is in flight; stop it first", removed: [] };
  }

  try {
    return await withProjectLock(resolved, "lookout ui reset", async () =>
      withStateLock(resolved, "queue", async () => resetProjectLocked(resolved)), { timeoutMs: 0 });
  } catch (error) {
    return { ok: false, why: (error as Error).message, removed: [] };
  }
}

async function resetProjectLocked(resolved: ResolvedConfig): Promise<ResetOutcome> {

  // The files. Entry by entry rather than removing the directory itself, which
  // is what keeps `ui.json` without having to read it out and write it back:
  // there is no window in which the settings exist only in this process.
  const dir = lookoutDir(resolved);
  const removed: string[] = [];
  if (existsSync(dir)) {
    for (const entry of await readdir(dir)) {
      if (KEEP.has(entry)) continue;
      await rm(join(dir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }

  // The caches over those files. `forgetBoard` drops the cached status body,
  // whose key is built by hand and would otherwise go on answering with the run
  // that has just been deleted; `forgetNarration` arms the reset frame that
  // tells every open page to throw its transcript away.
  forgetBoard();
  forgetNarration();

  // Clear the queue cache after deleting its authoritative file. `queueRev` is what the
  // status cache keys on, and `queueMtime` is what an outside edit is noticed
  // against, so a stale one would make the next read look unchanged.
  session.queue = [];
  session.queueProjectDir = resolved.projectDir;
  session.queueRev += 1;
  session.queueMtime = 0;
  // A failure banner from the run that no longer exists outlives its run
  // otherwise: it is held here, not in any file the delete above reached.
  session.lastFailure = null;

  return { ok: true, removed };
}
