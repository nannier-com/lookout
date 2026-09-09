/**
 * What a walk leaves behind: the check's report, plus one line per screen
 * saying whether it was reached, how, and what it cost. Rewritten after
 * every screen, so `lookout status` and the page see the walk as it goes,
 * and printed at the end in the check's own words.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import type { ReachResult } from "../navigator/reach.js";
import type { PlatformKind, ResolvedConfig, ShotRecord } from "../types.js";
import type { CheckOutcome } from "./outcome.js";
import type { LoadedJudging } from "./plan-load.js";
import { tallyFormFactors, tallyLines } from "./tally.js";
import type { ScreenStop } from "./walk-order.js";
import type { JudgedStop } from "./walk-stop.js";

export interface StopSummary {
  index: number;
  screen: string;
  target: string;
  route: string;
  state: string;
  platforms: PlatformKind[];
  status: "judged" | "cached" | "unjudged" | "unreachable" | "not-walked";
  how: "replay" | "navigator" | null;
  reason?: string;
  lastLook?: string;
  shots: number;
  findings: number;
  deterministicErrors: number;
  costUsd: number;
  navigatorCalls: number;
  seconds: number;
}

export interface WalkOutcome extends CheckOutcome {
  screens: { total: number; walked: number; judged: number; cached: number; unjudged: number; unreachable: number; notWalked: number };
  stops: StopSummary[];
  navigator: { calls: number; replays: number; costUsd: number };
  mapBuiltAt: string;
}

export function emptyWalkOutcome(loaded: LoadedJudging, resolved: ResolvedConfig, runId: string, total: number, mapBuiltAt: string): WalkOutcome {
  return {
    runId,
    model: loaded.model,
    rubricVersion: Math.max(0, ...loaded.panels.map((p) => p.version)),
    panels: loaded.panels.map((p) => p.def.name),
    shotsConsidered: 0,
    judged: 0,
    cached: 0,
    findings: [],
    refuted: [],
    repaired: [],
    droppedCriteria: [],
    degraded: [],
    rejected: 0,
    unjudged: 0,
    unaccounted: [],
    formFactors: [],
    failedBatches: [],
    deterministicErrors: 0,
    costUsd: 0,
    reportPath: join(evidenceDir(resolved), "judge-report.json"),
    screens: { total, walked: 0, judged: 0, cached: 0, unjudged: 0, unreachable: 0, notWalked: 0 },
    stops: [],
    navigator: { calls: 0, replays: 0, costUsd: 0 },
    mapBuiltAt,
  };
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Fold one reached and judged screen into the walk's report. Returns the new
 * report; the old one is not mutated. `judgedIds` is every shot judged so far
 * in this run, this screen's included: the tally counts a shot as cached when
 * it was not judged, and only the caller knows about the earlier screens.
 */
export function accumulate(
  outcome: WalkOutcome,
  stop: ScreenStop,
  index: number,
  reach: Extract<ReachResult, { ok: true }>,
  judged: JudgedStop,
  allShots: ShotRecord[],
  judgedIds: ReadonlySet<string>,
): WalkOutcome {
  const o = judged.outcome;
  const status: StopSummary["status"] = judged.allFailed ? "unjudged" : o.judged === 0 && o.cached > 0 ? "cached" : "judged";
  const summary: StopSummary = {
    index,
    screen: stop.id,
    target: stop.target,
    route: stop.route,
    state: stop.state,
    platforms: stop.platforms,
    status,
    how: reach.how,
    shots: reach.shots.length,
    findings: o.findings.length,
    deterministicErrors: o.deterministicErrors,
    costUsd: Number((reach.costUsd + o.costUsd).toFixed(4)),
    navigatorCalls: reach.navigatorCalls,
    seconds: reach.seconds,
  };
  const findings = [...outcome.findings, ...o.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const unaccounted = [...outcome.unaccounted, ...o.unaccounted];
  return {
    ...outcome,
    shotsConsidered: outcome.shotsConsidered + reach.shots.length,
    judged: outcome.judged + o.judged,
    cached: outcome.cached + o.cached,
    findings,
    refuted: [...outcome.refuted, ...o.refuted],
    repaired: [...outcome.repaired, ...o.repaired],
    droppedCriteria: [...outcome.droppedCriteria, ...o.droppedCriteria],
    degraded: [...outcome.degraded, ...o.degraded],
    rejected: outcome.rejected + o.rejected,
    unjudged: outcome.unjudged + o.unjudged,
    unaccounted,
    formFactors: tallyFormFactors(
      allShots,
      new Set(judgedIds),
      new Set(findings.map((f) => f.shotId)),
      new Set(unaccounted.flatMap((u) => u.shotIds)),
    ),
    failedBatches: [...outcome.failedBatches, ...o.failedBatches],
    deterministicErrors: outcome.deterministicErrors + o.deterministicErrors,
    costUsd: Number((outcome.costUsd + reach.costUsd + o.costUsd).toFixed(4)),
    screens: {
      ...outcome.screens,
      walked: outcome.screens.walked + 1,
      judged: outcome.screens.judged + (status === "judged" ? 1 : 0),
      cached: outcome.screens.cached + (status === "cached" ? 1 : 0),
      unjudged: outcome.screens.unjudged + (status === "unjudged" ? 1 : 0),
    },
    stops: [...outcome.stops, summary],
    navigator: {
      calls: outcome.navigator.calls + reach.navigatorCalls,
      replays: outcome.navigator.replays + (reach.how === "replay" ? 1 : 0),
      costUsd: Number((outcome.navigator.costUsd + reach.costUsd).toFixed(4)),
    },
  };
}

/** A screen the walk could not reach, or did not get to. */
export function unreached(
  outcome: WalkOutcome,
  stop: ScreenStop,
  index: number,
  status: "unreachable" | "not-walked",
  detail: { reason: string; lastLook?: string; costUsd?: number; navigatorCalls?: number; seconds?: number },
): WalkOutcome {
  const summary: StopSummary = {
    index,
    screen: stop.id,
    target: stop.target,
    route: stop.route,
    state: stop.state,
    platforms: stop.platforms,
    status,
    how: null,
    reason: detail.reason,
    ...(detail.lastLook ? { lastLook: detail.lastLook } : {}),
    shots: 0,
    findings: 0,
    deterministicErrors: 0,
    costUsd: detail.costUsd ?? 0,
    navigatorCalls: detail.navigatorCalls ?? 0,
    seconds: detail.seconds ?? 0,
  };
  return {
    ...outcome,
    costUsd: Number((outcome.costUsd + (detail.costUsd ?? 0)).toFixed(4)),
    screens: {
      ...outcome.screens,
      walked: outcome.screens.walked + (status === "unreachable" ? 1 : 0),
      unreachable: outcome.screens.unreachable + (status === "unreachable" ? 1 : 0),
      notWalked: outcome.screens.notWalked + (status === "not-walked" ? 1 : 0),
    },
    stops: [...outcome.stops, summary],
    navigator: {
      ...outcome.navigator,
      calls: outcome.navigator.calls + (detail.navigatorCalls ?? 0),
      costUsd: Number((outcome.navigator.costUsd + (detail.costUsd ?? 0)).toFixed(4)),
    },
  };
}

/** The walk's summary, in the check's format with the screens added. */
export function walkLines(outcome: WalkOutcome, shotsById: Map<string, ShotRecord>, evDir: string): string[] {
  const s = outcome.screens;
  const lines = [
    `${s.total} screen(s): ${s.judged} judged, ${s.cached} cached` +
      (s.unjudged > 0 ? `, ${s.unjudged} NOT judged` : "") +
      (s.unreachable > 0 ? `, ${s.unreachable} unreachable` : "") +
      (s.notWalked > 0 ? `, ${s.notWalked} not walked` : "") +
      `; ${outcome.findings.length} finding(s), ${outcome.refuted.length} refuted; ` +
      `${outcome.deterministicErrors} deterministic error(s); ~$${outcome.costUsd}` +
      ` (navigator ~$${outcome.navigator.costUsd} over ${outcome.navigator.calls} call(s), ${outcome.navigator.replays} replayed)`,
  ];
  for (const line of tallyLines(outcome.formFactors)) lines.push(`  ${line}`);
  for (const f of outcome.findings) {
    const shot = shotsById.get(f.shotId);
    lines.push(
      `  [${f.severity}] ${f.category}/${f.attribute} ${f.title}` +
        `\n    shot: ${f.shotId}${f.cached ? " (cached)" : ""}${f.verified ? " (verified)" : ""}` +
        (shot ? `\n    evidence: ${join(evDir, shot.path)}` : ""),
    );
  }
  for (const stop of outcome.stops.filter((x) => x.status === "unreachable" || x.status === "not-walked")) {
    lines.push(`  ${stop.status}: ${stop.screen}: ${stop.reason ?? ""}${stop.lastLook ? ` (last look: ${stop.lastLook})` : ""}`);
  }
  return lines;
}
