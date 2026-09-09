/**
 * Mapped states inside a plain check's scope: a scoped re-capture names a
 * route, and a route's rest is what `capture` photographs, but a state the
 * map reaches by clicking is only reachable by replaying its recording. When
 * `--screens` names such states, they are replayed into the capture's own run
 * here, so a ruling on a finding filed on one has fresh pixels to rule on.
 * No navigator is ever spent from this path; a screen with no recording is
 * reported and left out.
 */
import { EventLog, emit } from "../report/events.js";
import { resolveFormFactors, resolveSchemes } from "../capture/matrix.js";
import { DEFAULT_JUDGE_MODEL, PRIMARY_AI } from "../judge/engine.js";
import { loadMap } from "../map/store.js";
import { replayScreen, type ReachContext } from "../navigator/reach.js";
import { LookoutError, type PlatformKind, type ResolvedConfig } from "../types.js";
import { num, str, type Parsed } from "../util.js";
import { flattenScreens } from "./walk-order.js";
import { NAVIGATOR_TIMEOUT_MS } from "./walk-reach.js";

/** Replay the named mapped states into the run `runId`; returns what could not be replayed and why. */
export async function replayScreensIntoRun(
  resolved: ResolvedConfig,
  parsed: Parsed,
  screens: readonly string[],
  runId: string,
  platforms: PlatformKind[],
  log: (line: string) => void,
): Promise<{ replayed: string[]; skipped: { screen: string; reason: string }[] }> {
  const map = await loadMap(resolved);
  if (!map) throw new LookoutError("--screens names mapped screens, and this project has no screen map", "run `lookout map` first");
  const { stops } = flattenScreens(map, platforms);
  const axe = str(parsed.flags.axe) ?? "route";
  const ctx: ReachContext = {
    resolved,
    runId,
    platforms,
    formFactors: resolveFormFactors(parsed.flags.viewports),
    schemes: resolveSchemes(parsed.flags.schemes, resolved.config.schemes),
    capture: {
      axe: (["route", "all", "off"].includes(axe) ? axe : "route") as "route" | "all" | "off",
      axeContrast: !!parsed.flags["axe-contrast"],
      settleMs: num(parsed.flags.settle) ?? 400,
      headless: !parsed.flags.headed,
      provenance: resolved.config.provenance !== false && !parsed.flags["no-provenance"],
      aria: resolved.config.aria !== false && !parsed.flags["no-aria"],
      edgeClip: !parsed.flags["no-edge-clip"],
    },
    navigator: { ai: PRIMARY_AI, model: str(parsed.flags.model) ?? DEFAULT_JUDGE_MODEL, timeoutMs: NAVIGATOR_TIMEOUT_MS },
    log: EventLog.attach(resolved, runId),
  };
  const replayed: string[] = [];
  const skipped: { screen: string; reason: string }[] = [];
  for (const id of screens) {
    const stop = stops.find((s) => s.id === id);
    if (!stop) {
      skipped.push({ screen: id, reason: "not in the map" });
      continue;
    }
    if (stop.state === "rest") continue; // the route capture already photographed it
    const result = await replayScreen(stop, ctx);
    if (result.ok) {
      replayed.push(id);
      continue;
    }
    skipped.push({ screen: id, reason: result.reason });
    const line = `screen ${id} was not re-captured: ${result.reason}`;
    log(line);
    emit("note", line, { screen: id, reason: result.reason });
  }
  return { replayed, skipped };
}
