/**
 * What a capture run is allowed to look at, and whether it is there to look
 * at: the targets and routes the flags select, the matrix the flags narrow,
 * the fold the project walks, and the reachability probe each fold needs.
 * Shared by `capture`, `check`, and the screen walk, so no verb can quietly
 * default to fewer form factors than a sweep does or skip the probe.
 */
import { assertTargetsAllowed } from "../config.js";
import { preflight, requireUp, type ResolvedTarget } from "../targets.js";
import { mapOn } from "../map/consent.js";
import { resolveMappedTargets } from "../map/scope.js";
import { newestSourceMtime, staleMessage, staleStamp, staleTargets, type StaleStamp } from "../freshness.js";
import { emit } from "../report/events.js";
import { resolveFormFactors, resolvePlatforms, resolveSchemes } from "./matrix.js";
import { deviceDownReason, preflightDevices } from "./native-preflight.js";
import { detectProjectKind } from "../project-kind.js";
import type { FormFactor, PlatformKind, ResolvedConfig, Scheme } from "../types.js";
import { list, type Parsed } from "../util.js";

export interface RunPreflight {
  targets: ResolvedTarget[];
  formFactors: FormFactor[];
  schemes: Scheme[];
  platforms: PlatformKind[];
  nativePlatforms: ("ios" | "android")[];
  /**
   * Targets whose served build looked older than the source when the run
   * started, so the run records its own doubt. Absent when there was no reason
   * to doubt it, which keeps a clean run's flags clean.
   */
  staleBuild?: StaleStamp[];
}

export async function preflightRun(parsed: Parsed, resolved: ResolvedConfig): Promise<RunPreflight> {
  assertTargetsAllowed(resolved.config, !!parsed.flags["allow-remote"]);

  // The config's targets, extended in memory with the routes the screen map
  // discovered, so a scoped re-capture can name a mapped route and an
  // unscoped one photographs it at rest. `--no-map` is the config alone.
  const targets = await resolveMappedTargets(
    resolved,
    list(parsed.flags.targets),
    list(parsed.flags.routes),
    { useMap: mapOn(resolved.config, parsed.flags) },
  );
  // The matrix: every form factor and both schemes unless a flag narrows,
  // and the platforms the project's fold walks unless a flag decides.
  const formFactors = resolveFormFactors(parsed.flags.viewports);
  const schemes = resolveSchemes(parsed.flags.schemes, resolved.config.schemes);
  const platforms = resolvePlatforms(
    parsed.flags.platforms,
    await detectProjectKind(resolved.projectDir, resolved.config),
  );
  // Each fold is probed for what it needs and nothing else: the web fold's
  // URL over HTTP, the device fold's simulators and emulators with the app on
  // them. A native-only project has no server to answer, and asking one to
  // would stop every run before a device was ever looked at.
  const nativePlatforms = platforms.filter((p): p is "ios" | "android" => p !== "web");
  const webStatuses = platforms.includes("web") ? await preflight(targets) : [];
  requireUp(
    webStatuses,
    deviceDownReason(await preflightDevices(resolved.config, nativePlatforms)),
  );

  // Evidence that predates the code is worse than no evidence: the page renders
  // clean, the verdict reads clean, and both describe a build nobody is running
  // any more. Warn and stamp rather than refuse, because lookout never rebuilds
  // or restarts anything and only the operator can make the run worth having.
  // Only a server that dated what it served can be compared against the source,
  // so a hot-reload project never pays for the walk.
  const stale = webStatuses.some((s) => s.servedAt !== null)
    ? staleTargets(webStatuses, newestSourceMtime(resolved.projectDir))
    : [];
  const staleWarning = staleMessage(stale);
  if (staleWarning) {
    console.error(`lookout: ${staleWarning}`);
    emit("note", "capturing against a build older than the source", {
      staleBuild: staleStamp(stale),
    });
  }

  return {
    targets,
    formFactors,
    schemes,
    platforms,
    nativePlatforms,
    ...(stale.length > 0 ? { staleBuild: staleStamp(stale) } : {}),
  };
}
