/**
 * Incremental dispatch.
 *
 * A judge run takes minutes; making the session wait for the slowest batch
 * before it learns anything wastes all of that time. The streamer emits as the
 * evidence lands: every batch's findings are printed with their screenshot
 * paths the moment they are confirmed, and a cluster's brief is written the
 * moment that cluster's routes are fully judged, so fix sessions can be spawned
 * while the rest of the app is still being looked at.
 *
 * Emitting early trades one guarantee: a later batch can find the same defect
 * on a route that was still pending and so extend an already-dispatched
 * cluster. That is handled rather than prevented. The brief is rewritten, an
 * amendment is printed, and `verify-fix` re-judges the cluster's whole scope,
 * so a fix that covered only the first routes comes back still-open with a
 * fresh brief naming what remains. Correctness rests on the ruling, not on
 * perfect foresight.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { buildContactSheet, sheetNote } from "../capture/sheet.js";
import { aiToFindings, mergeFindings, type Backlog } from "../backlog/lib.js";
import { loadBacklog, saveBacklog } from "../verbs/backlog.js";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import type { VerifiedFinding } from "../judge/verify.js";
import { nowIso } from "../util.js";
import { clusterFindings, type FixCluster } from "./cluster.js";
import { writeBrief } from "./plan.js";
import { spawnLine } from "./brief.js";
import type { Severity } from "../types.js";

export interface BatchEvent {
  index: number;
  total: number;
  shots: ShotRecord[];
  findings: VerifiedFinding[];
  shotsById: Map<string, ShotRecord>;
}

export interface StreamerOptions {
  resolved: ResolvedConfig;
  runId: string;
  minSeverity: Severity;
  maxAttempts: number;
  log: (line: string) => void;
}

export interface Streamer {
  /**
   * Called once judging is about to begin. Deterministic findings are already
   * final at this point, so their clusters go out immediately rather than
   * waiting on a judge that cannot contradict them.
   */
  start: (toJudge: ShotRecord[]) => Promise<void>;
  onBatch: (e: BatchEvent) => Promise<void>;
  /** Emit anything still unemitted once judging is done. */
  finish: () => Promise<{ dispatched: string[]; backlog: Backlog | null }>;
}

function routeKey(target: string, route: string): string {
  return `${target}|${route}`;
}

export function createAutoStreamer(opts: StreamerOptions): Streamer {
  const { resolved, minSeverity, maxAttempts, log } = opts;

  // Shots still owed per route. A cluster is safe to dispatch once every route
  // it touches has none left.
  const pending = new Map<string, number>();

  const emitted = new Map<string, string>(); // cluster id -> fingerprints seen when emitted
  const dispatched: string[] = [];
  let backlog: Backlog | null = null;

  async function emitCluster(c: FixCluster, amended: boolean): Promise<void> {
    const brief = await writeBrief(resolved, c, maxAttempts);
    await clusterSheet(resolved, c);
    dispatched.push(c.id);
    log(
      `\n${amended ? "amended " : "dispatch"} ${c.id}` +
        `\n  ${c.severity} ${c.category}${c.defects.length > 1 ? ` (${c.defects.length} rules)` : `/${c.attribute}`}` +
        `  ${c.shotCount} shot(s)  ${c.routes.join(" ")}` +
        `\n  brief:  ${brief}` +
        (amended
          ? "\n  This cluster grew after it was first dispatched. Re-dispatch it on the" +
            "\n  brief above; the earlier session did not see every route."
          : `\n  ${spawnLine(c, brief)}`) +
        `\n  verify: lookout verify-fix --cluster ${c.id}`,
    );
  }

  async function sweep(): Promise<void> {
    if (!backlog) return;
    const clusters = clusterFindings(Object.values(backlog.findings), {
      minSeverity,
      maxAttempts,
    });
    for (const c of clusters) {
      // Deterministic findings come from rules, not from the judge, so they are
      // final as soon as capture is: dispatch them without waiting. Judged
      // findings wait for every route they touch to be fully judged.
      const deterministicOnly = c.members.every((m) => m.channel === "deterministic");
      const complete =
        deterministicOnly ||
        c.routes.every((r) => (pending.get(routeKey(c.target, r)) ?? 0) === 0);
      if (!complete) continue;
      const signature = c.fingerprints.join(",");
      const seen = emitted.get(c.id);
      if (seen === signature) continue;
      await emitCluster(c, seen !== undefined);
      emitted.set(c.id, signature);
    }
  }

  return {
    async start(toJudge: ShotRecord[]): Promise<void> {
      for (const s of toJudge) {
        const k = routeKey(s.target, s.route);
        pending.set(k, (pending.get(k) ?? 0) + 1);
      }
      // Deterministic findings from the capture that just finished.
      const { mergeLatest } = await import("../verbs/backlog.js");
      const merged = await mergeLatest(resolved, { judgeOutcome: null });
      backlog = merged.backlog;
      await sweep();
    },

    async onBatch(e: BatchEvent): Promise<void> {
      for (const s of e.shots) {
        const k = routeKey(s.target, s.route);
        pending.set(k, Math.max(0, (pending.get(k) ?? 0) - 1));
      }

      // Show the session what was just found, with the image to look at.
      const evDir = evidenceDir(resolved);
      for (const f of e.findings) {
        const shot = e.shotsById.get(f.shotId);
        log(
          `  finding [${f.severity}] ${f.category}/${f.attribute}  ${f.title}` +
            (shot ? `\n          ${join(evDir, shot.path)}` : ""),
        );
      }

      backlog = backlog ?? (await loadBacklog(resolved));
      if (e.findings.length > 0) {
        mergeFindings(backlog, aiToFindings(e.findings, e.shotsById), opts.runId, nowIso());
        await saveBacklog(resolved, backlog);
      }
      await sweep();
    },

    async finish(): Promise<{ dispatched: string[]; backlog: Backlog | null }> {
      for (const k of pending.keys()) pending.set(k, 0);
      backlog = backlog ?? (await loadBacklog(resolved));
      await sweep();
      return { dispatched, backlog };
    },
  };
}

/** One sheet per cluster, so a fix session sees its whole defect in one Read. */
export async function clusterSheet(
  resolved: ResolvedConfig,
  c: FixCluster,
): Promise<string | null> {
  const evDir = evidenceDir(resolved);
  const seen = new Set<string>();
  const tiles = [];
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    tiles.push({
      shot: {
        target: m.target,
        route: m.route,
        state: m.state,
        formFactor: m.formFactor,
        scheme: m.scheme,
        path: ev.path,
      },
      findings: 1,
    });
  }
  const res = await buildContactSheet(tiles, evDir, join(evDir, "fix", `${c.id}.sheet.png`));
  return res?.path ?? null;
}

export { sheetNote };
