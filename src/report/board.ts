/**
 * The board, built from what is durably on disk.
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
 * cluster's attempts and fix sessions are kept in `fix/<id>.state.json`. So the
 * board is derived from those, and the event log is demoted to what it actually
 * is: an overlay saying what is happening *right now*, on top of a board that
 * exists whether or not a run is in flight.
 *
 * The rule this encodes: outstanding work is state, not narration.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { clusterFindings, clusterIdOf, type FixCluster } from "../fix/cluster.js";
import { clusterLabel } from "../fix/brief.js";
import { loadState, type ClusterState } from "../fix/state.js";
import { loadBacklog } from "../verbs/backlog.js";
import type { FindingStatus } from "../backlog/lib.js";
import type { ResolvedConfig, Severity } from "../types.js";
import { readEvents, type LookoutEvent } from "./events.js";

/**
 * Where an issue stands. Every state is one lookout established itself: the
 * backlog says open, blocked, fixed or waived, and `verify-fix` says what it
 * saw last time it was asked to rule. Nothing here tracks who is working on
 * it, because lookout does not dispatch work and cannot know.
 */
export type IssueStatus =
  | "open"
  | "verifying"
  | "still-open"
  | "regressed"
  | "blocked"
  /** lookout confirmed the defect is gone. */
  | "done"
  /** Adjudicated as intentional, kept as record rather than as work. */
  | "archived";

/**
 * Read top to bottom, this is "what needs a person now" before "what is already
 * dealt with". Blocked sits above done and archived because lookout gave up on
 * it and the defect is still there.
 */
export const ORDER_BY_ATTENTION: Record<IssueStatus, number> = {
  verifying: 0,
  regressed: 1,
  "still-open": 2,
  open: 3,
  blocked: 4,
  done: 5,
  archived: 6,
};

/**
 * A screenshot, as the page needs it.
 *
 * Both forms of the path are carried on purpose. `path` is evidence-relative
 * because that is what the server serves thumbnails from; `absPath` is what
 * gets shown and copied, because whoever picks this issue up needs a path they
 * can open without knowing where lookout keeps its evidence.
 */
export interface BoardShot {
  path: string;
  absPath: string;
  route: string;
  formFactor: string;
  scheme: string;
  state?: string;
}

/** One line in lookout's record of an issue. */
export interface BoardStep {
  at: string;
  kind: "found" | "claimed" | "verify" | "verdict";
  text: string;
}

export interface BoardEntry {
  id: string;
  label: string;
  routes: string[];
  severity: string;
  category: string;
  /** The screenshots this issue was filed against. */
  shots: BoardShot[];
  /** What the most recent `verify-fix` saw afterwards. */
  recheck: BoardShot[];
  /** When lookout last saw this, or null when it cannot tell. */
  lastSeenAt: string | null;
  status: IssueStatus;
  /** Everything lookout has recorded about it, oldest first. */
  timeline: BoardStep[];
  /** Attempts spent asking lookout to rule on a claimed fix. */
  attempt: number;
  verdict: string | null;
  judgeNote: string | null;
}

/** Screenshots an issue was filed against, newest per member, both path forms. */
function shotsOf(resolved: ResolvedConfig, c: FixCluster): BoardShot[] {
  const evDir = evidenceDir(resolved);
  const seen = new Set<string>();
  const out: BoardShot[] = [];
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    out.push({
      path: ev.path,
      absPath: join(evDir, ev.path),
      route: m.route,
      formFactor: m.formFactor,
      scheme: m.scheme,
      state: m.state,
    });
  }
  return out;
}

/**
 * Where an issue stands.
 *
 * Every state here is something lookout itself established: the backlog says
 * whether the finding is open, blocked, fixed or waived, and `verify-fix` says
 * what happened the last time somebody asked it to rule. Nothing here tracks
 * who is working on it, because lookout does not dispatch work and has no way
 * to know.
 */
function durableStatus(c: FixCluster, state: ClusterState): IssueStatus {
  // Precedence is by how much attention it still wants: anything still open is
  // live work, then work lookout gave up on, then work it confirmed fixed, and
  // last the findings somebody adjudicated as intentional.
  const hasOpen = c.members.some((m) => m.status === "open");
  if (!hasOpen) {
    if (c.members.some((m) => m.status === "blocked")) return "blocked";
    if (c.members.some((m) => m.status === "fixed")) return "done";
    return "archived";
  }
  const lastAttempt = state.attempts[state.attempts.length - 1];
  if (lastAttempt?.verdict === "still-open" || lastAttempt?.verdict === "regressed") {
    return lastAttempt.verdict;
  }
  if (lastAttempt?.verdict === "blocked") return "blocked";
  return "open";
}

/**
 * What lookout has recorded about this issue: when it first saw it, and every
 * time it was asked to rule on a claimed fix.
 */
function durableTimeline(state: ClusterState, foundAt: string | null): BoardStep[] {
  const steps: BoardStep[] = foundAt
    ? [{ at: foundAt, kind: "found", text: "lookout filed this issue" }]
    : [];
  for (const a of state.attempts) {
    if (a.reported?.commit || a.reported?.note) {
      steps.push({
        at: a.dispatchedAt,
        kind: "claimed",
        text:
          "a fix was reported" +
          (a.reported.commit ? ` at ${a.reported.commit}` : "") +
          (a.reported.note ? `: ${a.reported.note}` : ""),
      });
    }
    if (!a.verdict) continue;
    steps.push({
      at: a.dispatchedAt,
      kind: "verdict",
      text: `lookout ruled it ${a.verdict}` + (a.judgeNote ? `: ${a.judgeNote}` : ""),
    });
  }
  return steps.sort((x, y) => x.at.localeCompare(y.at));
}

/**
 * When lookout last saw this issue: the mtime of the newest screenshot it was
 * filed against. There is no dispatch to date it by any more, and "last seen"
 * is the honest thing anyway, since a finding is only as current as the capture
 * that produced it.
 */
function lastSeenAt(resolved: ResolvedConfig, c: FixCluster, state: ClusterState): string | null {
  const evDir = evidenceDir(resolved);
  let newest: number | null = null;
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev) continue;
    try {
      const t = statSync(join(evDir, ev.path)).mtimeMs;
      if (newest === null || t > newest) newest = t;
    } catch {
      // A screenshot that has been cleaned up does not date the issue.
    }
  }
  if (newest !== null) return new Date(newest).toISOString();
  return state.attempts[0]?.dispatchedAt ?? null;
}

/**
 * The issue a `verify-fix` is judging this second, if one is, and everything
 * that run has said about it so far.
 *
 * Read from the events directly rather than from a fold, because a log
 * truncated by a plain `check` carries nothing else to attach to. The run is in
 * flight while its run-start has no matching run-end.
 */
function liveVerify(events: LookoutEvent[]): { cluster: string | null; steps: BoardStep[] } {
  let cluster: string | null = null;
  let runId: string | null = null;
  let steps: BoardStep[] = [];
  for (const e of events) {
    if (e.kind === "run-start" && e.data?.verb === "verify-fix") {
      cluster = typeof e.data.cluster === "string" ? e.data.cluster : null;
      runId = e.runId;
      steps = [{ at: e.at, kind: "verify", text: "lookout started re-judging this" }];
      continue;
    }
    if (e.runId !== runId) continue;
    if (e.kind === "run-end") {
      cluster = null;
      runId = null;
      steps = [];
      continue;
    }
    // The feed tails a run in progress, so anything it says belongs on it.
    if (e.kind === "phase") steps.push({ at: e.at, kind: "verify", text: e.message });
    else if (e.kind === "shot") {
      steps.push({ at: e.at, kind: "verify", text: `re-captured ${e.message}` });
    } else if (e.kind === "finding") {
      steps.push({ at: e.at, kind: "verdict", text: `still sees ${e.message}` });
    } else if (e.kind === "verdict") {
      steps.push({ at: e.at, kind: "verdict", text: e.message });
    } else if (e.kind === "error") {
      steps.push({ at: e.at, kind: "verdict", text: e.message });
    }
  }
  return { cluster, steps };
}

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
  // No attempt cap: a cluster that exhausted its attempts is blocked, and
  // blocked work is exactly what somebody looking at this needs to see.
  const clusters = clusterFindings(Object.values(backlog.findings), {
    statuses: ["open", "blocked", "fixed", "by-design"],
  });

  const durable = await Promise.all(
    clusters.map(async (c): Promise<BoardEntry> => {
      const state = await loadState(resolved, c.id);
      const seen = lastSeenAt(resolved, c, state);
      const lastAttempt = state.attempts[state.attempts.length - 1];
      return {
        id: c.id,
        label: clusterLabel(c),
        routes: c.routes,
        severity: c.severity,
        category: c.category,
        shots: shotsOf(resolved, c),
        recheck: [],
        lastSeenAt: seen,
        status: durableStatus(c, state),
        timeline: durableTimeline(state, seen),
        attempt: c.attemptsSpent,
        verdict: lastAttempt?.verdict ?? null,
        judgeNote: lastAttempt?.judgeNote ?? null,
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
 * A finding as the page needs it: the claim, the screenshot that proves it, and
 * which cluster owns it.
 *
 * Read from the backlog for the same reason the board is. The findings section
 * used to be built from `finding` events, so it emptied out with the log on
 * every re-capture, and the severity counts beside it described whatever
 * happened to be in the log rather than what is actually outstanding.
 */
export interface BoardFinding {
  fingerprint: string;
  severity: Severity;
  status: FindingStatus;
  category: string;
  attribute: string;
  title: string;
  problem: string;
  route: string;
  formFactor: string;
  scheme: string;
  path: string | null;
  /** Absolute, for whoever has to go and open it. */
  absPath: string | null;
  verified: boolean;
  /** The cluster this finding is dispatched under. */
  cluster: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Everything still outstanding, worst first. */
export async function durableFindings(resolved: ResolvedConfig): Promise<BoardFinding[]> {
  const backlog = await loadBacklog(resolved);
  const evDir = evidenceDir(resolved);
  const out: BoardFinding[] = [];
  for (const f of Object.values(backlog.findings)) {
    // Every status, including the settled ones: the page needs them to offer
    // "done" and "archived" views, and filters them back out by default.
    const ev = f.evidence[f.evidence.length - 1];
    out.push({
      fingerprint: f.fingerprint,
      severity: f.severity,
      status: f.status,
      category: f.category,
      attribute: f.attribute,
      title: f.title,
      problem: f.problem,
      route: f.route,
      formFactor: f.formFactor,
      scheme: f.scheme,
      path: ev?.path ?? null,
      absPath: ev ? join(evDir, ev.path) : null,
      verified: f.verified,
      cluster: clusterIdOf(f),
    });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.category.localeCompare(b.category) ||
      a.attribute.localeCompare(b.attribute),
  );
}

/** Counts by severity, for the headline row. */
export function severityTally(findings: BoardFinding[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  const t = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const f of findings) {
    t[f.severity]++;
    t.total++;
  }
  return t;
}

/**
 * Counts by state, for a caller that wants the headline without folding.
 *
 * `blocked` is counted on its own and never with `fixed`. It means lookout
 * exhausted a cluster's attempts and stopped dispatching it, so the defect is
 * still there and now needs a person. Filing it under a heading like "settled",
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
