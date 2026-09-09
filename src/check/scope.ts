/**
 * What a check is looking at: fresh evidence, and the shots in scope.
 *
 * Two decisions, and they belong together because the second is meaningless
 * without the first. A run either captures now or judges what is already on
 * disk, and then narrows to the targets and routes the caller asked for. Both
 * fail loudly rather than judging nothing quietly: an empty scope is somebody's
 * flags not matching anything, and reporting "clean" for it would be a lie
 * about an application nobody looked at.
 */
import { loadConfig } from "../config.js";
import { configuredScope } from "../config-scope.js";
import { emit } from "../report/events.js";
import { loadReport } from "../capture/store.js";
import { runCapture } from "../verbs/capture.js";
import { LookoutError, type PlatformKind, type ResolvedConfig, type ShotRecord } from "../types.js";
import { list, str, type Parsed } from "../util.js";

export interface CheckScope {
  resolved: ResolvedConfig;
  /** The web shots this run will consider, after --targets and --routes. */
  shots: ShotRecord[];
  shotsById: Map<string, ShotRecord>;
}

export async function resolveScope(parsed: Parsed): Promise<CheckScope> {
  // 1. Fresh evidence unless the caller judges an existing set.
  let resolved;
  if (parsed.flags["no-capture"]) {
    resolved = await loadConfig({ configPath: str(parsed.flags.config), url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]) });
  } else {
    const captured = await runCapture(parsed);
    resolved = captured.resolved;
    // Mapped states a scoped run names are reached by replaying what reached
    // them before, into this capture's run, so their pixels are as fresh as
    // the routes' when the judge looks.
    const screens = list(parsed.flags.screens);
    if (screens && screens.length > 0) {
      const { replayScreensIntoRun } = await import("./scope-screens.js");
      await replayScreensIntoRun(resolved, parsed, screens, captured.outcome.runId, captured.outcome.platforms as PlatformKind[], (line) => {
        if (!parsed.flags.json && !parsed.flags.quiet) console.log(line);
      });
    }
  }

  const report = await loadReport(resolved);
  if (!report || report.shots.length === 0) {
    throw new LookoutError(
      "no captured evidence to judge",
      "run `lookout capture` first, or drop --no-capture",
    );
  }

  // 2. Scope selection mirrors capture's flags, pinned to the CURRENT
  // config: the report accumulates across runs, so shots of routes or states
  // no longer configured would otherwise stay in judging scope forever,
  // paying capture and refreshing findings about screens nobody can reach.
  const onlyTargets = list(parsed.flags.targets);
  const onlyRoutes = list(parsed.flags.routes);
  const inScope = await configuredScope(resolved);
  const inConfig = report.shots.filter(inScope);
  const dropped = report.shots.filter((s) => s.platform === "web").length -
    inConfig.filter((s) => s.platform === "web").length;
  if (dropped > 0) {
    emit("note", `${dropped} stored shot(s) are for routes or states no longer configured; left out of scope`, {
      dropped,
    });
  }
  // Every platform's shots are judged: a device shot is a rendering of its
  // own, and it used to be captured and then dropped here before any panel
  // saw it. Navigation discovery stays web only (check/navigate.ts), since a
  // device has no DOM to harvest.
  const shots = inConfig.filter(
    (s) =>
      (!onlyTargets || onlyTargets.includes(s.target)) &&
      (!onlyRoutes ||
        onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
  );
  if (shots.length === 0) throw new LookoutError("no shots match the given --targets/--routes");
  const shotsById = new Map(shots.map((s) => [s.id, s]));

  return { resolved, shots, shotsById };
}
