/**
 * `lookout map`: read the source for the application's screens and how each
 * is reached, and write `.lookout/map.json` for `check` to walk.
 *
 * Exit 0 when every requested target has a map after the run; 1 when one
 * could not be mapped (the reply was unusable, or nothing survived the
 * parser), because a walk with nothing to walk is something the operator has
 * to hear about; 2 on a refused flag.
 */
import { loadConfig } from "../config.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";
import { runMap } from "../map/run.js";
import { mapJson, renderMap } from "../map/render.js";
import { LookoutError } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";

export async function map(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  for (const flag of ["max-screens", "max-depth"] as const) {
    if (parsed.flags[flag] !== undefined && num(parsed.flags[flag]) === undefined) {
      throw new LookoutError(`--${flag} needs a number`);
    }
  }
  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const log = (line: string): void => {
    if (!quiet) console.log(line);
  };

  // Joined, not started: the last check's board must survive a scan, the way
  // it survives a verify-fix.
  const elog = new EventLog(resolved, runId("map"));
  elog.join("lookout map", { verb: "map", targets: str(parsed.flags.targets) ?? null });
  setCurrentLog(elog);
  try {
    const result = await runMap(resolved, {
      targets: list(parsed.flags.targets),
      refresh: !!parsed.flags.refresh,
      ai: str(parsed.flags.ai),
      model: str(parsed.flags.model),
      maxScreens: num(parsed.flags["max-screens"]),
      maxDepth: num(parsed.flags["max-depth"]),
      log,
    });
    const screens = result.targets.reduce((sum, t) => sum + t.screens, 0);
    const failed = result.targets.filter((t) => t.status === "failed" || t.screens === 0);
    if (parsed.flags.json) printJson(mapJson(result));
    else console.log(renderMap(result, resolved.projectDir));
    emit("run-end", `map: ${screens} screen(s) across ${result.targets.length} target(s); ~$${result.costUsd}`, {
      screens,
      costUsd: result.costUsd,
      failed: failed.map((t) => t.name),
    });
    return failed.length > 0 ? 1 : 0;
  } finally {
    setCurrentLog(null);
  }
}
