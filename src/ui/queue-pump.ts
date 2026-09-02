/**
 * What moves the queue along: one issue handed over at a time, and the next one
 * only once lookout has ruled on the last.
 *
 * The advance condition is lookout's own record, not a process exiting. A
 * handoff opens a Terminal that this server has no handle on, so "the fix is
 * finished" is not a thing it can observe; "the defect is gone" is, because
 * `verify-fix` writes it down. The head therefore leaves the queue when the
 * board says done, archived or blocked, and not before.
 *
 * Three properties this has to keep, each of which is a bug if it slips:
 *
 * 1. **It writes only when something changed.** The watcher watches the whole
 *    of `.lookout/` recursively and the queue file lives in it, so a save is a
 *    nudge is a pump. An unconditional save is an 80ms loop with no input.
 * 2. **A failed handoff is terminal.** Recording "claude is not on PATH" is
 *    itself a save, and if the head still looked un-handed-off afterwards the
 *    same loop comes back through a different door.
 * 3. **It never throws.** It runs from a bare `setTimeout` in the watcher with
 *    no `try` above it, unlike every route and unlike the live channel's own
 *    snapshot.
 */
import { launchHandoff } from "../report/handoff.js";
import { boardNow } from "./payload.js";
import { queueDigest, queueMtime, loadQueue, saveQueue, type QueueItem } from "./queue.js";
import { checkIsRunning, session } from "./session.js";
import type { BoardEntry } from "../report/board-types.js";
import type { ResolvedConfig } from "../types.js";

/**
 * A handoff, injectable so a test and the visual gate can drive the whole pump
 * without a Terminal window opening on somebody's desk.
 */
export type Handoff = (
  resolved: ResolvedConfig,
  issue: string,
  tool: string,
) => Promise<{ launched: boolean; reason?: string }>;

let handoff: Handoff = launchHandoff;

/** For tests. Returns the previous one, so a test can put it back. */
export function setHandoff(next: Handoff): Handoff {
  const prev = handoff;
  handoff = next;
  return prev;
}

/**
 * A run of the gate, or of any harness driving the real server, must not open
 * Terminal windows on the machine running it. The switch is read here rather
 * than at startup so a test can set and clear it around one call.
 */
function handoffSuppressed(): boolean {
  return process.env.LOOKOUT_NO_HANDOFF === "1";
}

/** Statuses that mean lookout has finished with this issue, one way or another. */
const SETTLED = new Set(["done", "archived", "blocked"]);

/**
 * Whether this issue can still be won.
 *
 * An issue at its attempt cap gets ruled blocked by the next `verify-fix`
 * without being looked at, so handing it over is opening a window on a fight
 * that is already lost. The queue refuses it at the door instead.
 */
export function queueableReason(entry: BoardEntry | undefined, cap: number): string | null {
  if (!entry) return "no issue with that id";
  if (entry.status === "done" || entry.status === "archived") return "lookout has already ruled this one gone";
  if (entry.status === "blocked" || entry.attempt >= cap) {
    return `this one is out of attempts and needs a person: \`lookout backlog set --issue ${entry.id} --status open\` reopens it`;
  }
  return null;
}

/**
 * Advance the queue against whatever the board says right now.
 *
 * The one entry point everything outside this file uses: a route that just
 * changed the queue, the watcher noticing a run wrote, the backstop, and the
 * server's own start. It resolves the board through the payload's cache, so
 * the common case reads no files at all.
 */
export async function pumpQueue(resolved: ResolvedConfig): Promise<void> {
  await advanceQueue(resolved, await boardNow(resolved));
}

let pumping = false;
let pending = false;

/**
 * Bring the queue up to date with the board, and hand over the head if it is
 * the head's turn.
 *
 * `board` is the one the status payload just built. Building a second one here
 * would re-read the event log and every issue's state file, at up to twelve
 * times a second while a check is appending to it.
 */
export async function advanceQueue(resolved: ResolvedConfig, board: BoardEntry[]): Promise<void> {
  if (pumping) {
    pending = true;
    return;
  }
  pumping = true;
  try {
    let next = board;
    do {
      pending = false;
      await pumpOnce(resolved, next);
      // A request that arrived mid-pump was about a board this one had already
      // read, so the repeat asks for a current one. It is a cache hit unless
      // something actually moved, which is exactly when it should not be.
      if (pending) next = await boardNow(resolved);
    } while (pending);
  } catch {
    // Nothing above this catches, and a malformed backlog or an unknown id
    // must not take the watcher's timer down with it. The next write nudges
    // again; a queue that skipped one tick is not a queue that is broken.
  } finally {
    pumping = false;
  }
}

async function pumpOnce(resolved: ResolvedConfig, board: BoardEntry[]): Promise<void> {
  // Another `lookout ui` on this project, or somebody with an editor, wrote the
  // file since this process last touched it. Theirs is newer, so it wins.
  const onDisk = queueMtime(resolved.projectDir);
  if (onDisk > session.queueMtime) {
    session.queue = await loadQueue(resolved.projectDir);
    session.queueMtime = onDisk;
    session.queueRev++;
  }

  const before = queueDigest(session.queue);
  const byId = new Map(board.map((b) => [b.id, b]));
  // Drop everything lookout has finished with, not only the head: an issue
  // further down that somebody fixed out of order has no business waiting.
  let items = session.queue.filter((q) => {
    const entry = byId.get(q.issue);
    return !(entry && SETTLED.has(entry.status));
  });

  const head = items[0];
  if (head) items = [await stepHead(resolved, head, byId.get(head.issue)), ...items.slice(1)];

  if (queueDigest(items) === before) return;
  session.queue = items;
  session.queueRev++;
  await saveQueue(resolved.projectDir, items);
  session.queueMtime = queueMtime(resolved.projectDir);
}

/**
 * What to do about the issue at the front, which is the only one anything is
 * done about.
 *
 * Handed off and the attempt count unmoved means the fix is still in flight, or
 * the agent gave up without asking for a ruling. The queue cannot tell those
 * apart, so it says how long it has been and leaves the choice to whoever is
 * reading: the head row carries its age, a way to ask for the ruling, and an X.
 */
async function stepHead(
  resolved: ResolvedConfig,
  head: QueueItem,
  entry: BoardEntry | undefined,
): Promise<QueueItem> {
  // Terminal until somebody acts. Retrying here is what turns a missing binary
  // into an unbounded loop, because recording the reason is itself a write.
  if (head.failedAt) return head;
  // A check screenshots the tree the fix agent is editing, and its event log
  // truncation erases the ruling overlay of anything in flight. One at a time.
  if (checkIsRunning()) return head;

  const attempt = entry?.attempt ?? 0;
  const fresh = head.handedOffAt === undefined;
  const spent = head.handedOffAtAttempt !== undefined && attempt > head.handedOffAtAttempt;
  if (!fresh && !spent) return head;

  if (handoffSuppressed()) {
    return { ...head, handedOffAt: new Date().toISOString(), handedOffAtAttempt: attempt };
  }
  const r = await handoff(resolved, head.issue, head.tool);
  if (!r.launched) {
    return { ...head, failedAt: new Date().toISOString(), lastReason: r.reason ?? "the handoff did not open" };
  }
  const done: QueueItem = { ...head, handedOffAt: new Date().toISOString(), handedOffAtAttempt: attempt };
  delete done.lastReason;
  return done;
}
