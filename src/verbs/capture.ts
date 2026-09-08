/**
 * `lookout capture`: evidence only. Screenshots + deterministic findings
 * (console errors, page errors, horizontal overflow, axe violations, blank
 * shots), no AI. Exit 1 when any error-severity finding or route failure
 * surfaced, so callers can gate on it.
 */
import { join } from "node:path";
import { assertTargetsAllowed, evidenceDir, loadConfig } from "../config.js";
import { preflight, requireUp, resolveTargets } from "../targets.js";
import { newestSourceMtime, staleMessage, staleStamp, staleTargets } from "../freshness.js";
import { captureWeb, type WebCaptureOptions } from "../capture/web.js";
import { mergeRun, loadReport } from "../capture/store.js";
import {
  loadPlans,
  plannedStateIndex,
  updateHarvests,
  type RouteHarvest,
} from "../navigate/store.js";
import { navigationOn } from "../navigate/consent.js";
import { buildContactSheet, sheetNote } from "../capture/sheet.js";
import { emit, EventLog, setCurrentLog } from "../report/events.js";
import type { ShotRecord } from "../types.js";
import { LookoutError } from "../types.js";
import { resolveFormFactors, resolvePlatforms, resolveSchemes } from "../capture/matrix.js";
import { deviceDownReason, preflightDevices } from "../capture/native-preflight.js";
import { detectProjectKind } from "../project-kind.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";

/** Narrate one shot the moment it lands, so a live watcher sees it appear. */
function emitShot(shot: ShotRecord): void {
  emit("shot", `${shot.target}${shot.route} ${shot.formFactor} ${shot.scheme}`, {
    shotId: shot.id,
    path: shot.path,
    route: shot.route,
    state: shot.state,
    formFactor: shot.formFactor,
    scheme: shot.scheme,
    findings: shot.deterministicFindings.length,
  });
}

export interface CaptureOutcome {
  runId: string;
  /** The fold this run walked: web, devices, or both. */
  platforms: string[];
  shots: number;
  findings: { errors: number; warnings: number; infos: number };
  failures: { target: string; route: string; step: string; message: string }[];
  reportPath: string;
  evidenceDir: string;
  /** Labelled composite of this run's shots, for the calling session to read. */
  contactSheet?: string | null;
}

/** Shared by capture/check: run the web engine per current flags. */
export async function runCapture(parsed: Parsed): Promise<{
  outcome: CaptureOutcome;
  resolved: Awaited<ReturnType<typeof loadConfig>>;
}> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
    });
  assertTargetsAllowed(resolved.config, !!parsed.flags["allow-remote"]);

  const targets = resolveTargets(
    resolved.config,
    list(parsed.flags.targets),
    list(parsed.flags.routes),
    resolved.configPath,
  );
  // The matrix: every form factor and both schemes unless a flag narrows,
  // and the platforms the project's fold walks unless a flag decides.
  const formFactors = resolveFormFactors(parsed.flags.viewports);
  const schemes = resolveSchemes(parsed.flags.schemes);
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

  const axeFlag = str(parsed.flags.axe) ?? "route";
  if (!["route", "all", "off"].includes(axeFlag)) {
    throw new LookoutError(`--axe must be route | all | off`);
  }

  const quiet = !!parsed.flags.json || !!parsed.flags.quiet;
  const opts: WebCaptureOptions = {
    formFactors,
    schemes,
    axe: axeFlag as "route" | "all" | "off",
    axeContrast: !!parsed.flags["axe-contrast"],
    settleMs: num(parsed.flags.settle) ?? 400,
    states: parsed.flags["no-states"] ? "off" : "all",
    headless: !parsed.flags.headed,
    provenance: resolved.config.provenance !== false && !parsed.flags["no-provenance"],
    aria: resolved.config.aria !== false && !parsed.flags["no-aria"],
    edgeClip: !parsed.flags["no-edge-clip"],
    runId: runId("web"),
    staleBuild: stale.length > 0 ? staleStamp(stale) : undefined,
    onProgress: (line) => {
      if (!quiet) console.log(line);
      emit(line.startsWith("FAIL") ? "error" : "phase", line);
    },
    onShot: emitShot,
  };

  // Navigation discovery rides along when the config enables it: capture
  // harvests every route's affordances and executes already-planned states;
  // only `check` ever refreshes the plan (capture stays AI-free).
  const navEnabled = navigationOn(resolved.config, parsed.flags);
  const harvests = new Map<string, RouteHarvest>();
  if (navEnabled) {
    const plans = await loadPlans(resolved);
    opts.navigation = {
      plans: new Map(Object.entries(plans.routes)),
      onHarvest: (key, harvest) => harvests.set(key, harvest),
    };
  }

  let run: Awaited<ReturnType<typeof captureWeb>>["run"] | null = null;
  let shots: Awaited<ReturnType<typeof captureWeb>>["shots"] = [];
  if (platforms.includes("web")) {
    const web = await captureWeb(resolved, targets, opts);
    run = web.run;
    shots = web.shots;
    // An unscoped capture sees the config's whole intent, so it is the one
    // moment stored shots for since-removed routes or states can be retired.
    // Navigation-planned states are part of that intent while the plan names
    // them, so pruning consults the plan index the same way scope does.
    const unscoped = !parsed.flags.targets && !parsed.flags.routes;
    const { pruned } = await mergeRun(
      resolved,
      web.run,
      web.shots,
      unscoped
        ? {
            pruneNotIn: resolveTargets(resolved.config, undefined, undefined, resolved.configPath),
            plannedStates: navEnabled ? await plannedStateIndex(resolved) : undefined,
          }
        : {},
    );
    if (pruned > 0) {
      const line = `pruned ${pruned} shot(s) for routes or states no longer configured`;
      if (!quiet) console.log(line);
      emit("note", line, { pruned });
    }
    if (navEnabled && harvests.size > 0) {
      await updateHarvests(resolved, (file) => {
        for (const [key, harvest] of harvests) file.routes[key] = harvest;
      });
      const line = `navigation: harvested ${harvests.size} route(s)`;
      if (!quiet) console.log(line);
      emit("note", line, { harvested: harvests.size });
    }
  }

  if (nativePlatforms.length > 0) {
    const { captureNative } = await import("../capture/native.js");
    // The native app's routes come from the config-named target (default first).
    const nativeTargetName = resolved.config.native?.target;
    const nativeTargets = nativeTargetName
      ? targets.filter((t) => t.def.name === nativeTargetName)
      : targets;
    if (nativeTargets.length === 0) {
      throw new LookoutError(`native.target "${nativeTargetName}" is not among the selected targets`);
    }
    const native = await captureNative(resolved, nativeTargets, {
      platforms: nativePlatforms,
      schemes,
      runId: opts.runId + "-native",
      onProgress: (line) => {
      if (!quiet) console.log(line);
      emit(line.startsWith("FAIL") ? "error" : "phase", line);
    },
    onShot: emitShot,
    });
    await mergeRun(resolved, native.run, native.shots);
    shots = [...shots, ...native.shots];
    run = run ?? native.run;
    if (run !== native.run) {
      run.failures.push(...native.run.failures);
      run.skips.push(...native.run.skips);
    }
  }
  if (!run) throw new LookoutError("nothing captured (no platforms selected)");

  const all = shots.flatMap((s) => s.deterministicFindings);
  const outcome: CaptureOutcome = {
    runId: run.id,
    platforms,
    // contactSheet is filled in by the verb once the sheet is composited;
    // runCapture itself is shared with `check`, which builds its own sheet with
    // the defect-carrying tiles marked.
    shots: shots.length,
    findings: {
      errors: all.filter((f) => f.severity === "error").length,
      warnings: all.filter((f) => f.severity === "warning").length,
      infos: all.filter((f) => f.severity === "info").length,
    },
    failures: run.failures,
    reportPath: join(evidenceDir(resolved), "capture-report.json"),
    evidenceDir: evidenceDir(resolved),
  };
  return { outcome, resolved };
}

export async function capture(parsed: Parsed): Promise<number> {
  const pre = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  const elog = new EventLog(pre, runId("capture"));
  elog.start("lookout capture", { project: pre.project });
  setCurrentLog(elog);

  const { outcome, resolved } = await runCapture(parsed);
  emit("capture-done", `${outcome.shots} shot(s) captured`, { shots: outcome.shots });
  const sheet = await runContactSheet(resolved, await shotsOfRun(resolved, outcome.runId));
  outcome.contactSheet = sheet?.path ?? null;

  if (parsed.flags.json) {
    printJson(outcome);
  } else {
    console.log(
      `\n${outcome.shots} shot(s); ${outcome.findings.errors} error, ` +
        `${outcome.findings.warnings} warning finding(s); ${outcome.failures.length} route failure(s)`,
    );
    console.log(`evidence: ${outcome.evidenceDir}`);
    for (const f of outcome.failures) {
      console.log(`  FAILED ${f.target}${f.route}: ${f.message}`);
    }
    if (sheet) console.log(`\n${sheetNote(sheet)}`);
  }
  emit("run-end", `${outcome.shots} shot(s), ${outcome.failures.length} failure(s)`, {
    shots: outcome.shots,
    failures: outcome.failures.length,
  });
  setCurrentLog(null);
  return outcome.failures.length > 0 || outcome.findings.errors > 0 ? 1 : 0;
}

/**
 * Composite a set of shots into a labelled sheet under the evidence directory.
 * Shared with `check` and `verify-fix`, which pass finding counts so the tiles
 * carrying defects are marked.
 */
export async function runContactSheet(
  resolved: Awaited<ReturnType<typeof loadConfig>>,
  shots: ShotRecord[],
  findingsByShot?: Map<string, number>,
  outName = "contact-sheet.png",
): Promise<Awaited<ReturnType<typeof buildContactSheet>>> {
  const evDir = evidenceDir(resolved);
  return buildContactSheet(
    shots.map((shot) => ({ shot, findings: findingsByShot?.get(shot.id) })),
    evDir,
    join(evDir, outName),
  );
}

/** The shots one run produced, for a run-scoped sheet. */
export async function shotsOfRun(
  resolved: Awaited<ReturnType<typeof loadConfig>>,
  runIdValue: string,
): Promise<ShotRecord[]> {
  const report = await loadReport(resolved);
  return report ? report.shots.filter((s) => s.runId === runIdValue) : [];
}
