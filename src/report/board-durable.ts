/**
 * The half of a board entry that is true whether or not anything is running.
 *
 * Everything here is read from disk: the backlog says whether a finding is
 * open, blocked, fixed or waived, `issues/<id>/state.json` holds the attempts
 * and what each fixer claimed, and the capture workspace dates it. That is the
 * whole point of the split this module belongs to. The board used to be a fold
 * over the event log, which every `check` truncates, so a project with
 * thirty-seven open findings showed "nothing dispatched yet" the moment
 * anything re-captured.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { frameServedPath, type Frame } from "../issues/frames.js";
import { wasPhotographed, type IssueRecord } from "../backlog/lib.js";
import { commitUrl, forgeOf } from "./forge.js";
import type { ClusterState } from "../fix/state.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig } from "../types.js";
import type { BoardEntry, BoardShot, BoardStep, IssueStatus } from "./board-types.js";

export function shotsOf(resolved: ResolvedConfig, c: FixCluster): BoardShot[] {
  const evDir = evidenceDir(resolved);
  const seen = new Set<string>();
  const out: BoardShot[] = [];
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    // A board tile IS a screenshot; a code-channel member has none to show.
    if (!ev || seen.has(ev.path) || !wasPhotographed(m)) continue;
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
 * The commit behind this issue, if anything has claimed one.
 *
 * A ruled fix outranks a reported one: `fixedIn` is written by `verify-fix`
 * when it agreed the defect was gone, and the attempt log holds whatever the
 * last fixer said, ruled or not.
 */
export function fixOf(
  c: FixCluster,
  state: ClusterState,
  forge: Awaited<ReturnType<typeof forgeOf>>,
): BoardEntry["fix"] {
  const ruled = c.members.find((m) => m.fixedIn?.commit)?.fixedIn?.commit ?? null;
  const attempt = [...state.attempts].reverse().find((a) => a.reported?.commit);
  const commit = ruled ?? attempt?.reported?.commit ?? null;
  if (!commit) return null;
  return {
    commit,
    short: commit.slice(0, 8),
    url: forge ? commitUrl(forge, commit) : null,
    host: forge?.host ?? null,
    cleared: !!ruled,
    at: attempt?.dispatchedAt ?? null,
  };
}

/**
 * A frozen frame, in the two path forms the page needs. Frames live in the
 * issue's own folder, so the served path is `issues/...` rather than a
 * workspace shot's, and the ui routes each to its own root.
 */
export function asBoardShot(resolved: ResolvedConfig, id: string, f: Frame): BoardShot {
  const { path, absPath } = frameServedPath(resolved, id, f);
  return {
    path,
    absPath,
    route: f.route,
    formFactor: f.formFactor,
    scheme: f.scheme,
    ...(f.state ? { state: f.state } : {}),
    ...(f.at ? { at: f.at } : {}),
  };
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
export function durableStatus(
  c: FixCluster,
  state: ClusterState,
  record: IssueRecord | undefined,
): IssueStatus {
  // Filed away by hand outranks every derived state below, because it is the
  // one somebody chose. It cannot hide live work: the reconcile that runs on
  // every save clears the flag the moment a finding reopens.
  if (record?.archived) return "archived";
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
  if (lastAttempt?.verdict === "still-open") return "still-open";
  if (lastAttempt?.verdict === "blocked") return "blocked";
  return "open";
}

/**
 * What lookout has recorded about this issue: when it first saw it, and every
 * time it was asked to rule on a claimed fix.
 */
export function durableTimeline(state: ClusterState, foundAt: string | null): BoardStep[] {
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
    // What the fix surfaced elsewhere, said plainly and without blame: these
    // are their own issues, and this one is not answerable for them.
    if (a.spawned && a.spawned.length > 0) {
      steps.push({
        at: a.dispatchedAt,
        kind: "found",
        text:
          a.spawned.length === 1
            ? `fixing this surfaced issue ${a.spawned[0]}`
            : `fixing this surfaced issues ${a.spawned.join(", ")}`,
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
export function lastSeenAt(resolved: ResolvedConfig, c: FixCluster, state: ClusterState): string | null {
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
