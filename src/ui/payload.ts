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
import { evidenceDir, lookoutDir } from "../config.js";
import { readEvents, summarise, type LookoutEvent, type RunStatus } from "../report/events.js";
import { buildBoard, severityTally, tally, type BoardEntry } from "../report/board.js";
import { buildLearning, learningBadge, learningKey, type Learning } from "../report/learning.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import { checkIsRunning, checkIsStopping, session } from "./session.js";
import type { QueueItem } from "./queue.js";
import type { ResolvedConfig } from "../types.js";

/**
 * The board is derived from the backlog and one state file per cluster, which
 * is a hundred kilobytes of reads. The page polls every 1.5 seconds, so the
 * result is held until something on disk actually moves.
 */
let boardCache: { key: string; body: string; board: BoardEntry[] } | null = null;

function diskKey(resolved: ResolvedConfig): string {
  const parts: string[] = [];
  for (const p of [
    join(lookoutDir(resolved), "backlog.json"),
    join(evidenceDir(resolved), "events.jsonl"),
    join(lookoutDir(resolved), "issues"),
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

/** Throw the board away: the project changed under it. */
export function forgetBoard(): void {
  boardCache = null;
}

/**
 * What lookout has changed about itself, held the way the board is held.
 *
 * Assembling it reads the skill files, the amendment history, the frozen set,
 * this project's incident log and a git log of lookout's own checkout. The
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
 * What one poll of `/api/status` answers.
 *
 * Written down as a type because the page is checked against it: the client
 * modules import this, so a field that changes shape here fails the build
 * rather than quietly rendering "undefined" in somebody's browser. The counts
 * borrow their shapes from the functions that produce them, so there is one
 * definition of each and not two that can disagree.
 */
export interface StatusPayload {
  project: string;
  projectDir: string;
  configured: boolean;
  /** Why the last run this page started ended badly, if it did. */
  lastFailure: { code: number | null; message: string } | null;
  status: RunStatus & {
    board: BoardEntry[];
    issues: ReturnType<typeof tally>;
    checkRunning: boolean;
    /** Whether that run has been told to stop and is still on its way down. */
    checkStopping: boolean;
    /**
     * Which verb is in the run slot, so the page says what stop would stop.
     *
     * `runKind` and not `running`: `RunStatus` already carries a boolean by
     * that name, meaning "the event log says a run is open", which is a
     * different question from "this server is holding a child".
     */
    runKind: "check" | "verify-fix" | null;
    /**
     * The issues waiting to be handed over, head first.
     *
     * Carried as the queue's own record and nothing more: the board is in this
     * same payload with every issue's title and status, so the page joins the
     * two by id rather than the server sending each issue twice.
     */
    queue: QueueItem[];
    /**
     * How many rulings an issue gets before it is blocked.
     *
     * Sent because the card needs it: an issue at its cap is one `verify-fix`
     * answers exit 3 for without looking, so offering to queue it is offering a
     * press the server refuses. Better not to draw the button than to draw one
     * that answers 409.
     */
    attemptCap: number;
    findings: ReturnType<typeof severityTally>;
    /** One line about lookout working on lookout, for the rail. */
    learning: ReturnType<typeof learningBadge>;
  };
  events: LookoutEvent[];
}

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
    checkIsRunning(resolved) +
    "|" +
    // Pressing stop moves nothing on disk, so without this the cached body
    // would keep telling the page the button had not been pressed.
    checkIsStopping(resolved) +
    "|" +
    (session.lastFailure ? `${session.lastFailure.code}:${session.lastFailure.message}` : "") +
    "|" +
    // Queueing moves nothing `diskKey` stats: `queue.json` is a sibling of the
    // backlog and the issues directory, not one of them. Without this term the
    // page would keep being served the queue from before the press, which is
    // the same bug the stopping term above exists for.
    session.queueRev;
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
  const payload: StatusPayload = {
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
      checkRunning: checkIsRunning(resolved),
      checkStopping: checkIsStopping(resolved),
      runKind: checkIsRunning(resolved) ? session.running?.kind ?? null : null,
      queue: session.queue,
      attemptCap: DEFAULT_MAX_ATTEMPTS,
      findings: severityTally(outstanding),
      // One line about lookout working on lookout, so the rail can say so
      // from whichever area is open.
      learning: learningBadge(await learningNow(resolved)),
    },
    events: events.slice(-400),
  };
  const body = JSON.stringify(payload);
  boardCache = { key, body, board };
  return body;
}

/**
 * The board the last payload was built from, building one if none is current.
 *
 * The queue's pump needs to know where the head stands, and that answer is
 * already in memory: assembling a second board would re-read the event log and
 * every issue's state file, which during a check is a hundred kilobytes at
 * whatever rate the log is being appended to.
 */
export async function boardNow(resolved: ResolvedConfig): Promise<BoardEntry[]> {
  await statusBody(resolved);
  return boardCache?.board ?? [];
}
