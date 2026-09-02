/**
 * Noticing that something happened, without being asked.
 *
 * lookout's own runs are separate processes: `check` and `verify-fix` narrate
 * by appending to `events.jsonl` and by saving the backlog, and they do not
 * know the page exists. So the server watches the two directories those runs
 * write into, and pushes the board down the open sockets when either moves.
 * That is what makes the page live for a run started in any terminal, not just
 * for one the play button spawned.
 *
 * One directory, because everything a run writes is under the project's own
 * `.lookout/`: the backlog and the issue folders at the top of it, the run log
 * and the shots inside `workspace/`. The watch is recursive, so the workspace
 * is covered by the same watcher; arming both would be two callbacks for one
 * write, since `arm` dedupes by exact string and neither path contains the
 * other as a string it would recognise.
 *
 * A watcher is not a guarantee. `fs.watch` is unreliable on network mounts and
 * silently stops on some of them, and a directory that does not exist yet
 * cannot be watched at all, which is the normal state of a project nothing has
 * ever been captured for. So a slow backstop runs underneath: it arms whatever
 * has appeared since, and pushes. It is a stat of three paths against a cached
 * body, not a rebuild, and it stops entirely when no page is open.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lookoutDir } from "../config.js";
import { liveCount, pushNarration, pushNow } from "./live.js";
import { currentProjectOrNull, onProjectChange } from "./session.js";

/**
 * How long to wait before acting on a change.
 *
 * One shot lands a PNG, a report and several log lines within a few
 * milliseconds of each other, and each of those is its own event. Without this
 * a single capture would rebuild the board a dozen times.
 */
const COALESCE_MS = 80;

/** How often to catch what the watchers missed, and arm what has appeared. */
const BACKSTOP_MS = 5000;

const armed = new Map<string, FSWatcher>();
let coalesce: ReturnType<typeof setTimeout> | null = null;
let backstop: ReturnType<typeof setInterval> | null = null;

/** The directories a run writes into, for whatever project is current. */
function watched(): string[] {
  const project = currentProjectOrNull();
  return project ? [lookoutDir(project)] : [];
}

function nudge(): void {
  if (coalesce) return;
  coalesce = setTimeout(() => {
    coalesce = null;
    void pushNow();
    // Cheap beside it rather than folded into it: what a judge is saying moves
    // many times a second while the board it will land on does not move at all,
    // and the board's own push is a cache hit whenever only narration changed.
    pushNarration();
  }, COALESCE_MS);
}

/**
 * Watch what exists and is not watched yet, and drop what is no longer wanted.
 *
 * Idempotent on purpose: it runs on every backstop tick as well as on a project
 * change, so a directory created by the first capture of a fresh project is
 * picked up without the server being restarted.
 */
function arm(): void {
  const want = new Set(watched());
  for (const [dir, watcher] of armed) {
    if (want.has(dir)) continue;
    watcher.close();
    armed.delete(dir);
  }
  for (const dir of want) {
    if (armed.has(dir) || !existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { recursive: true }, nudge);
      // A watcher that fails later must not throw out of the event loop, and
      // must not stay in the map claiming to be watching something.
      watcher.on("error", () => {
        watcher.close();
        armed.delete(dir);
      });
      armed.set(dir, watcher);
    } catch {
      // The directory went away between the check and the watch, or the
      // platform refused. The backstop will try again.
    }
  }
}

/** Begin watching, and keep watching whatever project the page points at. */
export function startWatching(): void {
  arm();
  onProjectChange(() => {
    arm();
    nudge();
  });
  backstop ??= setInterval(() => {
    // Nobody is reading. Arming and pushing would both be work for no one.
    if (liveCount() === 0) return;
    arm();
    void pushNow();
    pushNarration();
  }, BACKSTOP_MS);
  // Do not hold the process open on the backstop alone.
  backstop.unref?.();
}

/** Stop watching. For tests, and for a server that is shutting down. */
export function stopWatching(): void {
  for (const [, watcher] of armed) watcher.close();
  armed.clear();
  if (coalesce) {
    clearTimeout(coalesce);
    coalesce = null;
  }
  if (backstop) {
    clearInterval(backstop);
    backstop = null;
  }
}

/** Which directories are being watched right now. Exported for the test. */
export function watching(): string[] {
  return [...armed.keys()];
}
