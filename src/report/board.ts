/**
 * The board: what work exists, and what is happening to it this second.
 *
 * The board used to be a fold over the event log alone, which was wrong in a
 * way that only showed up after a restart: `events.jsonl` is narration, and
 * every `check` or `capture` run truncates it. So a project with thirty-seven
 * open findings and eighteen briefs written would show "nothing dispatched yet"
 * the moment anything re-captured, and the whole history of who fixed what was
 * gone with it.
 *
 * The durable answer was always sitting next to it. `backlog.json` is the
 * adjudicated record of every finding, clustering is deterministic, and each
 * cluster's attempts and fix sessions are kept in `issues/<id>/state.json`. So
 * the board is derived from those, and the event log is demoted to what it
 * actually is: an overlay saying what is happening *right now*, on top of a
 * board that exists whether or not a run is in flight.
 *
 * The rule this encodes: outstanding work is state, not narration. It is also
 * why this is three files. `board-types` is the contract the page draws against,
 * `board-durable` reads the state, `board-live` reads the narration, and what is
 * left here is the join, plus the two tallies that count what came out.
 */
import { issuesOf } from "../issues/registry.js";
import { clusterLabel } from "../fix/brief.js";
import { loadBacklog } from "../verbs/backlog.js";
import { loadFrames } from "../issues/frames.js";
import { loadState } from "../fix/state.js";
import { forgeOf } from "./forge.js";
import { readEvents, type LookoutEvent } from "./events.js";
import { issueDir } from "../issues/paths.js";
import {
  asBoardShot,
  durableStatus,
  durableTimeline,
  fixOf,
  lastSeenAt,
  shotsOf,
} from "./board-durable.js";
import { liveVerify } from "./board-live.js";
import type { ResolvedConfig } from "../types.js";
import { ORDER_BY_ATTENTION, type BoardEntry } from "./board-types.js";

// The contract lives next door, but this is where every caller looks for it.
export type { BoardEntry, BoardShot, BoardStep, IssueStatus } from "./board-types.js";
export { ORDER_BY_ATTENTION };

/**
 * Outstanding work, from disk, with anything the run in flight knows laid over
 * the top. Pass the events in when you have already read them, so a caller
 * polling twice a second reads the log once.
 */
export async function buildBoard(
  resolved: ResolvedConfig,
  events?: LookoutEvent[],
): Promise<BoardEntry[]> {
  const backlog = await loadBacklog(resolved);
  // No attempt cap: an issue that exhausted its attempts is blocked, and
  // blocked work is exactly what somebody looking at this needs to see.
  const clusters = issuesOf(backlog);
  // Read once for the whole board rather than per card, and memoised beyond
  // that: this is the project's remote, and it does not change while a page is
  // open.
  const forge = await forgeOf(resolved.projectDir);

  const durable = await Promise.all(
    clusters.map(async (c): Promise<BoardEntry> => {
      const state = await loadState(resolved, c.id);
      const record = backlog.issues?.[c.id];
      const frames = await loadFrames(resolved, c.id);
      const seen = lastSeenAt(resolved, c, state);
      const lastAttempt = state.attempts[state.attempts.length - 1];
      return {
        id: c.id,
        key: c.key,
        dir: issueDir(resolved, c.id),
        label: clusterLabel(c),
        routes: c.routes,
        severity: c.severity,
        category: c.category,
        defects: c.defects.map((d) => ({
          attribute: d.attribute,
          severity: d.severity,
          title: d.title,
          problem: d.problem,
        })),
        shots: shotsOf(resolved, c),
        before: frames.before.map((f) => asBoardShot(resolved, f)),
        after: frames.after.map((f) => asBoardShot(resolved, f)),
        lastSeenAt: seen,
        status: durableStatus(c, state, record),
        timeline: durableTimeline(state, seen),
        acceptance: record?.acceptance ?? [],
        attempt: c.attemptsSpent,
        verdict: lastAttempt?.verdict ?? null,
        judgeNote: lastAttempt?.judgeNote ?? null,
        fix: fixOf(c, state, forge),
        archived: record?.archived
          ? { at: record.archived.at, reason: record.archived.reason }
          : // An issue everything was waived on is archived in the older sense,
            // and the card should still be able to say which kind it is.
            durableStatus(c, state, record) === "archived"
            ? { at: seen ?? "", reason: "intentional" as const }
            : null,
      };
    }),
  );

  const evts = events ?? readEvents(resolved);
  const byId = new Map(durable.map((e) => [e.id, e]));

  // The one thing disk cannot know: lookout is re-judging this issue right now,
  // and what it has said while doing it. The card's record tails that live.
  const live = liveVerify(evts);
  const beingVerified = live.cluster ? byId.get(live.cluster) : undefined;
  if (beingVerified) {
    if (beingVerified.status !== "blocked") beingVerified.status = "verifying";
    beingVerified.timeline = [...beingVerified.timeline, ...live.steps];
  }

  const ORDER = ORDER_BY_ATTENTION;
  return [...byId.values()].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      // Undated sorts last within a status: lookout cannot say how current it is.
      Number(a.lastSeenAt === null) - Number(b.lastSeenAt === null) ||
      (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
  );
}

/**
 * Counts by severity, for the headline row. Takes issues now rather than
 * findings: an issue is the thing you act on, and counting its findings
 * separately made "5 critical" mean something different from the five cards
 * underneath it.
 */
export function severityTally(items: { severity: string }[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  const t = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const f of items) {
    if (f.severity in t) t[f.severity as keyof typeof t]++;
    t.total++;
  }
  return t;
}

/**
 * Counts by state, for a caller that wants the headline without folding.
 *
 * `blocked` is counted on its own and never with `fixed`. It means an issue
 * exhausted its `verify-fix` attempts, so the defect is still there and now
 * needs a person. Filing it under a heading like "settled",
 * next to work that actually passed, reads as success and buries exactly the
 * work somebody needs to pick up.
 */
export function tally(board: BoardEntry[]): {
  open: number;
  verifying: number;
  blocked: number;
  done: number;
  archived: number;
} {
  const t = { open: 0, verifying: 0, blocked: 0, done: 0, archived: 0 };
  for (const e of board) {
    if (e.status === "verifying") t.verifying++;
    else if (e.status === "blocked") t.blocked++;
    else if (e.status === "done") t.done++;
    else if (e.status === "archived") t.archived++;
    else t.open++;
  }
  return t;
}
