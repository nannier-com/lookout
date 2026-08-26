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
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { clusterFindings, clusterIdOf, type FixCluster } from "../fix/cluster.js";
import { clusterLabel } from "../fix/brief.js";
import { briefPath, fixDir, loadState, type ClusterState } from "../fix/state.js";
import { loadBacklog } from "../verbs/backlog.js";
import type { FindingStatus } from "../backlog/lib.js";
import type { ResolvedConfig, Severity } from "../types.js";
import {
  readEvents,
  summarise,
  type AgentStatus,
  type BoardEntry,
  type BoardShot,
  type BoardStep,
  type LookoutEvent,
} from "./events.js";

/** Screenshots a cluster was filed against, evidence-relative, newest per member. */
function shotsOf(c: FixCluster): BoardShot[] {
  const seen = new Set<string>();
  const out: BoardShot[] = [];
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    out.push({
      path: ev.path,
      route: m.route,
      formFactor: m.formFactor,
      scheme: m.scheme,
      state: m.state,
    });
  }
  return out;
}

/**
 * Where a cluster stands according to disk alone. `verifying` is deliberately
 * absent: a re-judge in flight is the one thing only the live log knows, and
 * claiming it from a stale state file would say lookout is looking when it is
 * not.
 */
function durableStatus(c: FixCluster, state: ClusterState): AgentStatus {
  if (c.members.every((m) => m.status === "blocked")) return "blocked";
  const lastAttempt = state.attempts[state.attempts.length - 1];
  const sessions = state.sessions ?? [];
  const lastSession = sessions[sessions.length - 1];
  // A session opened after the last ruling supersedes it: somebody is having
  // another go at a cluster that was handed back.
  const sessionIsNewer =
    lastSession !== undefined &&
    (lastAttempt === undefined || lastSession.startedAt > lastAttempt.dispatchedAt);
  if (sessionIsNewer) return lastSession.finishedAt ? "reported" : "working";
  if (lastAttempt?.verdict === "still-open" || lastAttempt?.verdict === "regressed") {
    return lastAttempt.verdict;
  }
  if (lastAttempt?.verdict === "blocked") return "blocked";
  if (lastSession) return lastSession.finishedAt ? "reported" : "working";
  return "queued";
}

/** Rebuild a cluster's account of itself from the state file, not the log. */
function durableTimeline(
  c: FixCluster,
  state: ClusterState,
  dispatchedAt: string | null,
): BoardStep[] {
  const steps: BoardStep[] = dispatchedAt
    ? [{ at: dispatchedAt, kind: "dispatch", text: "dispatched by lookout" }]
    : [];
  for (const s of state.sessions ?? []) {
    steps.push({ at: s.startedAt, kind: "start", text: `${s.name} picked this up` });
    for (const n of s.notes) steps.push({ at: n.at, kind: "note", text: n.text });
    if (s.finishedAt) {
      steps.push({
        at: s.finishedAt,
        kind: "done",
        text:
          "reported back" +
          (s.reported?.commit ? ` at ${s.reported.commit}` : "") +
          (s.reported?.note ? `: ${s.reported.note}` : ""),
      });
    }
  }
  for (const a of state.attempts) {
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
 * When this cluster first became work: the earliest thing anybody recorded
 * about it. The brief's mtime alone is not enough, because `verify-fix`
 * rewrites the brief when it hands a cluster back, which would move the
 * dispatch to after the session that already worked it.
 *
 * Null when nothing has been recorded at all: the finding is outstanding but
 * has never actually been sent to anybody. Faking an epoch here put
 * "dispatched 496604h06m" on the card.
 */
function dispatchedAtOf(
  resolved: ResolvedConfig,
  c: FixCluster,
  state: ClusterState,
): string | null {
  const candidates: string[] = [];
  try {
    const brief = briefPath(resolved, c.id);
    if (existsSync(brief)) candidates.push(new Date(statSync(brief).mtimeMs).toISOString());
  } catch {
    // An unreadable brief is not fatal; the records below still date it.
  }
  const firstAttempt = state.attempts[0];
  if (firstAttempt) candidates.push(firstAttempt.dispatchedAt);
  const firstSession = (state.sessions ?? [])[0];
  if (firstSession) candidates.push(firstSession.startedAt);
  return candidates.length > 0 ? candidates.sort()[0]! : null;
}

/**
 * The cluster a `verify-fix` is judging this second, if one is.
 *
 * Read from the events directly rather than from the folded board, because the
 * fold only knows a cluster it saw dispatched, and a log truncated by a plain
 * `check` carries no dispatches at all. The run is in flight while its
 * run-start has no matching run-end.
 */
function verifyingNow(events: LookoutEvent[]): string | null {
  let cluster: string | null = null;
  let runId: string | null = null;
  for (const e of events) {
    if (e.kind === "run-start" && e.data?.verb === "verify-fix") {
      cluster = typeof e.data.cluster === "string" ? e.data.cluster : null;
      runId = e.runId;
    } else if (e.kind === "run-end" && e.runId === runId) {
      cluster = null;
      runId = null;
    }
  }
  return cluster;
}

function mergeSteps(a: BoardStep[], b: BoardStep[]): BoardStep[] {
  const seen = new Set<string>();
  const out: BoardStep[] = [];
  for (const s of [...a, ...b].sort((x, y) => x.at.localeCompare(y.at))) {
    const key = `${s.at}|${s.kind}|${s.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
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
    statuses: ["open", "blocked"],
  });

  const durable = await Promise.all(
    clusters.map(async (c): Promise<BoardEntry> => {
      const state = await loadState(resolved, c.id);
      const sheet = join(fixDir(resolved), `${c.id}.sheet.png`);
      const dispatchedAt = dispatchedAtOf(resolved, c, state);
      const sessions = state.sessions ?? [];
      const last = sessions[sessions.length - 1];
      const lastAttempt = state.attempts[state.attempts.length - 1];
      return {
        id: c.id,
        label: clusterLabel(c),
        brief: briefPath(resolved, c.id),
        sheet: existsSync(sheet) ? sheet : null,
        routes: c.routes,
        severity: c.severity,
        category: c.category,
        shots: shotsOf(c),
        recheck: [],
        dispatchedAt,
        amended: false,
        status: durableStatus(c, state),
        agent: last
          ? {
              name: last.name,
              startedAt: last.startedAt,
              lastSeenAt: last.lastSeenAt,
              finishedAt: last.finishedAt ?? null,
              commit: last.reported?.commit ?? null,
              note: last.reported?.note ?? null,
              notes: last.notes,
            }
          : null,
        timeline: durableTimeline(c, state, dispatchedAt),
        attempt: c.attemptsSpent,
        verdict: lastAttempt?.verdict ?? null,
        judgeNote: lastAttempt?.judgeNote ?? null,
      };
    }),
  );

  const evts = events ?? readEvents(resolved);
  const live = summarise(evts).board;
  const byId = new Map(durable.map((e) => [e.id, e]));

  // A re-judge in flight is the one thing disk cannot know.
  const verifying = verifyingNow(evts);
  const beingVerified = verifying ? byId.get(verifying) : undefined;
  if (beingVerified && beingVerified.status !== "blocked") beingVerified.status = "verifying";

  for (const l of live) {
    const d = byId.get(l.id);
    if (!d) {
      // Live knows about a cluster the backlog no longer lists: it passed, and
      // its findings are closed. Worth showing while the run is still up.
      byId.set(l.id, l);
      continue;
    }
    // Disk is authoritative for what the work IS. The log is authoritative only
    // for what is happening this second: a re-judge in flight, a verdict that
    // has not been written back yet, and re-check screenshots.
    if (l.status === "verifying" || l.status === "passed") d.status = l.status;
    if (l.recheck.length > 0) d.recheck = l.recheck;
    if (l.verdict) {
      d.verdict = l.verdict;
      d.judgeNote = l.judgeNote ?? d.judgeNote;
    }
    if (l.amended) d.amended = true;
    d.timeline = mergeSteps(d.timeline, l.timeline);
  }

  const ORDER: Record<AgentStatus, number> = {
    working: 0,
    reported: 1,
    verifying: 2,
    regressed: 3,
    "still-open": 4,
    queued: 5,
    blocked: 6,
    passed: 7,
  };
  return [...byId.values()].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      // Never dispatched sorts last within its status: it is work nobody has
      // been given yet, rather than work somebody is sitting on.
      Number(a.dispatchedAt === null) - Number(b.dispatchedAt === null) ||
      (a.dispatchedAt ?? "").localeCompare(b.dispatchedAt ?? ""),
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
  verified: boolean;
  /** The cluster this finding is dispatched under. */
  cluster: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Everything still outstanding, worst first. */
export async function durableFindings(resolved: ResolvedConfig): Promise<BoardFinding[]> {
  const backlog = await loadBacklog(resolved);
  const out: BoardFinding[] = [];
  for (const f of Object.values(backlog.findings)) {
    if (f.status !== "open" && f.status !== "blocked") continue;
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

/** Counts by state, for a caller that wants the headline without folding. */
export function tally(board: BoardEntry[]): {
  queued: number;
  working: number;
  reported: number;
  resolved: number;
} {
  const t = { queued: 0, working: 0, reported: 0, resolved: 0 };
  for (const e of board) {
    if (e.status === "working" || e.status === "verifying") t.working++;
    else if (e.status === "reported") t.reported++;
    else if (e.status === "passed" || e.status === "blocked") t.resolved++;
    else t.queued++;
  }
  return t;
}
