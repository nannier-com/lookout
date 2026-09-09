/**
 * The record: once the navigator says the screen is showing, lookout
 * photographs it the way a capture would, at every form factor and scheme,
 * by re-navigating to the route and replaying the actions that reached the
 * screen as a state recipe. The navigator's own view was one form factor in
 * one scheme; the judges get the matrix.
 */
import type { Page } from "playwright";
import { captureRoute } from "../capture/web-route.js";
import { markSchemeMismatches } from "../capture/web-page.js";
import { resolveRoutes } from "../targets.js";
import type { EventLog } from "../report/events.js";
import { DEFAULT_VIEWPORTS, FORM_FACTORS, type DeterministicFinding, type FormFactor, type ResolvedConfig, type ShotRecord, type TargetDef } from "../types.js";
import type { NavAction } from "./actions.js";
import { recipeFrom, type ReplayContext } from "./replay-web.js";
import type { NavSession } from "./session.js";

export async function arriveWeb(args: {
  page: Page;
  resolved: ResolvedConfig;
  session: NavSession;
  def: TargetDef;
  /** Every action since `open`, the way the navigator performed them. */
  actions: NavAction[];
  replay: ReplayContext;
  log: EventLog;
  collectorDrain: () => DeterministicFinding[];
}): Promise<{ shots: ShotRecord[]; failures: { step: string; message: string }[] }> {
  const { resolved, session, def } = args;
  const { config } = resolved;
  const screen = session.screen;
  const route = resolveRoutes({ ...def, routes: [screen.route] }, config.element, resolved.configPath)[0]!;
  route.name = screen.routeName || route.name;
  if (screen.element !== undefined && screen.element !== null) route.element = screen.element;

  const viewports: Record<FormFactor, { width: number; height: number }> = { ...DEFAULT_VIEWPORTS, ...(config.viewports ?? {}) };
  // Widest first, whatever order the caller listed: the judge sees the full
  // layout before its scaled-down variants (the capture engine's own rule).
  const formFactors = FORM_FACTORS.filter((f) => session.matrix.formFactors.includes(f));
  const shots: ShotRecord[] = [];
  const failures: { step: string; message: string }[] = [];
  const progress = (line: string): void => {
    args.log.emit(line.startsWith("FAIL") ? "error" : "phase", line);
  };
  const only =
    screen.state === "rest"
      ? { state: "rest", recipe: null }
      : {
          state: screen.state,
          recipe: recipeFrom(args.actions, args.replay, screen.description),
          ...(screen.affordance ? { affordance: screen.affordance } : {}),
        };
  try {
    await captureRoute(resolved, { def, routes: [route] }, route, args.page, {
      ...session.capture,
      formFactors,
      schemes: session.matrix.schemes,
      states: "off",
      runId: session.runId,
      viewports,
      shots,
      collectorDrain: args.collectorDrain,
      progress,
      // Narrated into the run's board the way a capture narrates, and with
      // the same line, so a watcher cannot tell which process took it.
      onShot: (shot) => emitShotThrough(args.log, shot),
      only,
    });
  } catch (e) {
    failures.push({ step: "capture", message: (e as Error).message.slice(0, 500) });
    progress(`FAIL ${def.name}${screen.route} ${screen.state}: ${(e as Error).message.slice(0, 200)}`);
  }
  markSchemeMismatches(shots);
  return { shots, failures };
}

/** The capture verb's `emitShot` line, written to the log attached to the run rather than the process-wide one. */
function emitShotThrough(log: EventLog, shot: ShotRecord): void {
  log.emit("shot", `${shot.target}${shot.route} ${shot.formFactor} ${shot.scheme}`, {
    shotId: shot.id,
    path: shot.path,
    route: shot.route,
    state: shot.state,
    formFactor: shot.formFactor,
    scheme: shot.scheme,
    findings: shot.deterministicFindings.length,
  });
}
