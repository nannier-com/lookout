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
import { loadReport } from "../capture/store.js";
import { runCapture } from "../verbs/capture.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../types.js";
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
    resolved = (await runCapture(parsed)).resolved;
  }

  const report = await loadReport(resolved);
  if (!report || report.shots.length === 0) {
    throw new LookoutError(
      "no captured evidence to judge",
      "run `lookout capture` first, or drop --no-capture",
    );
  }

  // 2. Scope selection mirrors capture's flags.
  const onlyTargets = list(parsed.flags.targets);
  const onlyRoutes = list(parsed.flags.routes);
  const shots = report.shots.filter(
    (s) =>
      s.platform === "web" &&
      (!onlyTargets || onlyTargets.includes(s.target)) &&
      (!onlyRoutes ||
        onlyRoutes.some((r) => s.route === r || s.route === `/${r}` || s.routeName === r)),
  );
  if (shots.length === 0) throw new LookoutError("no shots match the given --targets/--routes");
  const shotsById = new Map(shots.map((s) => [s.id, s]));

  return { resolved, shots, shotsById };
}
