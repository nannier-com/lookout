/**
 * What the page polls for, and the caches that make polling cheap.
 *
 * Two answers are assembled here. The board is the durable one: the backlog,
 * one state file per cluster, and the event log laid over the top to say what
 * is happening this second. The self-improvement record is the other, and it
 * reads a dozen files plus a git log of lookout's own checkout.
 *
 * Both are held until something on disk actually moves, because the page asks
 * every 1.5 seconds and neither answer changes that often. The keys are the
 * whole design: a cache that cannot notice a run starting is a page that says
 * nothing is happening while something is.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { readEvents, summarise } from "../report/events.js";
import { buildBoard, severityTally, tally } from "../report/board.js";
import { buildLearning, learningBadge, learningKey, type Learning } from "../report/learning.js";
import { checkIsRunning, session } from "./session.js";
import type { ResolvedConfig } from "../types.js";

/**
 * The board is derived from the backlog and one state file per cluster, which
 * is a hundred kilobytes of reads. The page polls every 1.5 seconds, so the
 * result is held until something on disk actually moves.
 */
let boardCache: { key: string; body: string } | null = null;

function diskKey(resolved: ResolvedConfig): string {
  const parts: string[] = [];
  for (const p of [
    join(lookoutRoot(resolved), "backlog.json"),
    join(evidenceDir(resolved), "events.jsonl"),
    join(lookoutRoot(resolved), "issues"),
  ]) {
    try {
      const st = statSync(p);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

function lookoutRoot(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "..");
}

/** Throw the board away: the project changed under it. */
export function forgetBoard(): void {
  boardCache = null;
}

/**
 * What lookout has changed about itself, held the way the board is held.
 *
 * Assembling it reads the skill files, the amendment history, the frozen set,
 * the machine-wide incident log and a git log of lookout's own checkout. The
 * page polls, so the answer is kept until one of those moves. Both readers
 * share the cache: the area itself serves this object, and the rail's dot is
 * one line folded out of the same one.
 */
let learningCache: { key: string; value: Learning } | null = null;

export async function learningNow(resolved: ResolvedConfig): Promise<Learning> {
  const key = resolved.projectDir + "|" + learningKey(resolved);
  if (learningCache?.key === key) return learningCache.value;
  const value = await buildLearning(resolved);
  learningCache = { key, value };
  return value;
}

/** Read a JSON request body, capped so a stray POST cannot fill memory. */

/**
 * The board payload, from cache when nothing has moved.
 *
 * Returns the serialised body rather than an object because that is what the
 * cache holds: re-stringifying a board of forty issues on every poll was the
 * cost this cache exists to avoid.
 */
export async function statusBody(resolved: ResolvedConfig): Promise<string> {
  // Keyed on the project too, so pointing lookout elsewhere cannot serve the
  // previous one's board.
  // The failure is part of the key: a body cached from before a run died
  // would keep serving "nothing wrong here" over the top of the reason.
  const key =
    resolved.projectDir +
    "|" +
    diskKey(resolved) +
    "|" +
    // The rail's dot rides on this payload, so a heal starting or an
    // amendment landing has to invalidate it: without this the cached body
    // would keep saying lookout is idle while it is rewriting itself.
    learningKey(resolved) +
    "|" +
    checkIsRunning() +
    "|" +
    (session.lastFailure ? `${session.lastFailure.code}:${session.lastFailure.message}` : "");
  if (boardCache?.key === key) return boardCache.body;

  const events = readEvents(resolved);
  const status = summarise(events);
  // The board is what work exists, which lives in the backlog and the
  // per-cluster state files. The event log only says what is happening
  // this second, and every capture truncates it.
  const board = await buildBoard(resolved, events);
  // Severity counts issues, not findings: an issue is the thing you act
  // on, and counting its findings separately made "5 critical" mean
  // something different from the five cards under it.
  const outstanding = board.filter(
    (b) => b.status !== "done" && b.status !== "archived",
  );
  const body = JSON.stringify({
    project: resolved.project,
    projectDir: resolved.projectDir,
    configured: resolved.configPath !== null,
    // Why the last run this page started ended badly, if it did. Null is
    // the common case and means nothing has gone wrong, not that nothing
    // is known.
    lastFailure: session.lastFailure,
    status: {
      ...status,
      board,
      issues: tally(board),
      checkRunning: checkIsRunning(),
      findings: severityTally(outstanding),
      // One line about lookout working on lookout, so the rail can say so
      // from whichever area is open.
      learning: learningBadge(await learningNow(resolved)),
    },
    events: events.slice(-400),
  });
  boardCache = { key, body };
  return body;
}
