/**
 * `lookout capture`: evidence only. Screenshots + deterministic findings
 * (console errors, page errors, horizontal overflow, axe violations, blank
 * shots), no AI. Exit 1 when any error-severity finding or route failure
 * surfaced, so callers can gate on it.
 */
import { assertTargetsAllowed, loadConfig } from "../config.js";
import { preflight, requireUp, resolveTargets } from "../targets.js";
import { captureWeb, type WebCaptureOptions } from "../capture/web.js";
import { mergeRun, loadReport } from "../capture/store.js";
import { buildContactSheet, sheetNote } from "../capture/sheet.js";
import type { FormFactor, Scheme, ShotRecord } from "../types.js";
import { LookoutError } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";
import { join } from "node:path";

const FORM_FACTORS: FormFactor[] = ["desktop", "tablet", "phone"];
const SCHEMES: Scheme[] = ["dark", "light"];

export interface CaptureOutcome {
  runId: string;
  shots: number;
  findings: { errors: number; warnings: number; infos: number };
  failures: { target: string; route: string; step: string; message: string }[];
  reportPath: string;
  evidenceDir: string;
  /** Labelled composite of this run's shots, for the calling session to read. */
  contactSheet: string | null;
}

/** Shared by capture/check: run the web engine per current flags. */
export async function runCapture(parsed: Parsed): Promise<{
  outcome: CaptureOutcome;
  resolved: Awaited<ReturnType<typeof loadConfig>>;
}> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    });
  assertTargetsAllowed(resolved.config, !!parsed.flags["allow-remote"]);

  const targets = resolveTargets(
    resolved.config,
    list(parsed.flags.targets),
    list(parsed.flags.routes),
    resolved.configPath,
  );
  requireUp(await preflight(targets));

  const formFactors = (list(parsed.flags.viewports) as FormFactor[] | undefined) ?? FORM_FACTORS;
  for (const f of formFactors) {
    if (!FORM_FACTORS.includes(f)) {
      throw new LookoutError(`unknown viewport "${f}" (phone | tablet | desktop)`);
    }
  }
  const schemes = (list(parsed.flags.schemes) as Scheme[] | undefined) ?? SCHEMES;
  for (const s of schemes) {
    if (!SCHEMES.includes(s)) throw new LookoutError(`unknown scheme "${s}" (dark | light)`);
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
    runId: runId("web"),
    onProgress: quiet ? undefined : (line) => console.log(line),
  };

  const platforms = list(parsed.flags.platforms) ?? ["web"];
  for (const p of platforms) {
    if (!["web", "ios", "android"].includes(p)) {
      throw new LookoutError(`unknown platform "${p}" (web | ios | android)`);
    }
  }

  let run: Awaited<ReturnType<typeof captureWeb>>["run"] | null = null;
  let shots: Awaited<ReturnType<typeof captureWeb>>["shots"] = [];
  if (platforms.includes("web")) {
    const web = await captureWeb(resolved, targets, opts);
    run = web.run;
    shots = web.shots;
    await mergeRun(resolved, web.run, web.shots);
  }

  const nativePlatforms = platforms.filter((p): p is "ios" | "android" => p !== "web");
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
      onProgress: quiet ? undefined : (line) => console.log(line),
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
    // Filled in by the verb once the sheet is composited; runCapture itself is
    // shared with `check`, which builds its own marked-up sheet instead.
    contactSheet: null,
    shots: shots.length,
    findings: {
      errors: all.filter((f) => f.severity === "error").length,
      warnings: all.filter((f) => f.severity === "warning").length,
      infos: all.filter((f) => f.severity === "info").length,
    },
    failures: run.failures,
    reportPath: `${resolved.projectDir}/.lookout/evidence/capture-report.json`,
    evidenceDir: `${resolved.projectDir}/.lookout/evidence`,
  };
  return { outcome, resolved };
}

export async function capture(parsed: Parsed): Promise<number> {
  const { outcome, resolved } = await runCapture(parsed);
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
  const evDir = join(resolved.projectDir, ".lookout", "evidence");
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
