/**
 * Reaching one stop of the walk: replay first, a navigator when replay
 * cannot, two attempts at most, and an incident when both fail. What the
 * navigator learned is written back into the map so the next run replays it.
 */
import { EventLog, emit } from "../report/events.js";
import { recordIncident } from "../skills/incidents.js";
import { nodeByScreen, updateMap } from "../map/store.js";
import type { RunPreflight } from "../capture/run-preflight.js";
import type { ReachContext, ReachResult, Screen } from "../navigator/reach.js";
import { LookoutError, type ResolvedConfig } from "../types.js";
import { nowIso, num, str, type Parsed } from "../util.js";
import type { WalkCaps } from "./walk-flags.js";
import type { ScreenStop } from "./walk-order.js";

/** How long one navigator call may run: under the run log's staleness window, with room for the capture. */
export const NAVIGATOR_TIMEOUT_MS = 8 * 60_000;

export interface WalkSeams {
  reachScreen: (screen: Screen, ctx: ReachContext) => Promise<ReachResult>;
  replayScreen: (screen: Screen, ctx: ReachContext) => Promise<ReachResult>;
  /** What the walk learned about a screen, written into the map. */
  recordReach: (stop: ScreenStop, result: ReachResult) => Promise<void>;
}

/** The default write-back: the node's `walk` record, under the map lock. */
export function mapWriter(resolved: ResolvedConfig): WalkSeams["recordReach"] {
  return async (stop, result) => {
    await updateMap(resolved, (file) => {
      const node = nodeByScreen(file, stop.target, stop.route, stop.state);
      if (!node) return;
      if (result.ok) {
        node.walk = {
          reached: true,
          verifiedAt: nowIso(),
          actions: result.recorded,
          ...(result.arrival ? { arrival: result.arrival } : {}),
          shotIds: result.shots.map((s) => s.id),
        };
      } else {
        // The recording is kept for the next attempt; what is written down
        // is that it did not reach the screen this time, and why.
        node.walk = { ...(node.walk ?? {}), reached: false, verifiedAt: nowIso(), reason: result.reason };
      }
    });
  };
}

/** The reach context, from the same flags a capture reads. */
export function reachContext(args: {
  resolved: ResolvedConfig;
  pf: RunPreflight;
  parsed: Parsed;
  runId: string;
  caps: WalkCaps;
}): ReachContext {
  const { resolved, pf, parsed } = args;
  const axe = str(parsed.flags.axe) ?? "route";
  if (!["route", "all", "off"].includes(axe)) throw new LookoutError("--axe must be route | all | off");
  return {
    resolved,
    runId: args.runId,
    platforms: pf.platforms,
    formFactors: pf.formFactors,
    schemes: pf.schemes,
    capture: {
      axe: axe as "route" | "all" | "off",
      axeContrast: !!parsed.flags["axe-contrast"],
      settleMs: num(parsed.flags.settle) ?? 400,
      headless: !parsed.flags.headed,
      provenance: resolved.config.provenance !== false && !parsed.flags["no-provenance"],
      aria: resolved.config.aria !== false && !parsed.flags["no-aria"],
      edgeClip: !parsed.flags["no-edge-clip"],
    },
    navigator: { ...args.caps.navigator, timeoutMs: NAVIGATOR_TIMEOUT_MS },
    log: EventLog.attach(resolved, args.runId),
  };
}

export interface ReachBudget {
  navigatorCalls: number;
}

/** Whether a stop can be reached without a navigator: a route by URL, a state by its recording. */
export function replayable(stop: ScreenStop): boolean {
  return stop.state === "rest" || !!stop.node.walk?.reached;
}

function unreachable(reason: string, seconds = 0): ReachResult & { attempts: number } {
  return { ok: false, reason, costUsd: 0, navigatorCalls: 0, seconds, attempts: 0 };
}

export async function reachStop(
  stop: ScreenStop,
  ctx: ReachContext,
  seams: WalkSeams,
  caps: WalkCaps,
  budget: ReachBudget,
): Promise<ReachResult & { attempts: number }> {
  if (replayable(stop) && caps.replay !== "never") {
    emit("phase", `screen ${stop.id}: replaying`, { screen: stop.id });
    const replayed = await seams.replayScreen(stop, ctx);
    if (replayed.ok) return { ...replayed, attempts: 0 };
    if (caps.replay === "only") return { ...replayed, attempts: 0 };
    ctx.log.emit("note", `screen ${stop.id}: replay failed (${replayed.reason}); asking the navigator`, { screen: stop.id, reason: replayed.reason });
  } else if (caps.replay === "only") {
    return unreachable("no recording; run without --replay-only to record it");
  }

  let last: ReachResult | null = null;
  let attempts = 0;
  // What this stop spent, apart from what the run has spent: the summary
  // line is about the screen, the cap is about the run.
  let costUsd = 0;
  let calls = 0;
  for (; attempts < 2; ) {
    if (budget.navigatorCalls >= caps.maxNavigatorCalls) {
      return {
        ok: false,
        reason: `beyond this run's navigator cap (${caps.maxNavigatorCalls})${last && !last.ok ? `; last: ${last.reason}` : ""}`,
        ...(last && !last.ok && last.lastLook ? { lastLook: last.lastLook } : {}),
        costUsd,
        navigatorCalls: calls,
        seconds: 0,
        attempts,
      };
    }
    attempts++;
    emit("phase", `screen ${stop.id}: reaching (attempt ${attempts})`, { screen: stop.id, attempt: attempts });
    const result = await seams.reachScreen(stop, ctx);
    budget.navigatorCalls += result.navigatorCalls;
    calls += result.navigatorCalls;
    costUsd += result.costUsd;
    if (result.ok) {
      await seams.recordReach(stop, result).catch((e: Error) => {
        ctx.log.emit("note", `could not write the recording for ${stop.id} into the map: ${e.message}`, { screen: stop.id });
      });
      return { ...result, costUsd, navigatorCalls: calls, attempts };
    }
    last = result;
  }
  const failed = last as Extract<ReachResult, { ok: false }>;
  recordIncident({
    at: nowIso(),
    kind: "screen-unreachable",
    verb: "check",
    message: `screen ${stop.id} unreachable after ${calls} navigator call(s): ${failed.reason}`,
    ...(failed.lastLook ? { detail: failed.lastLook } : {}),
    project: ctx.resolved.projectDir,
  });
  await seams.recordReach(stop, failed).catch(() => {});
  return { ...failed, costUsd, navigatorCalls: calls, attempts };
}
