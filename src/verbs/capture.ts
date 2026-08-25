/**
 * `lookout capture`: evidence only. Screenshots + deterministic findings
 * (console errors, page errors, horizontal overflow, axe violations, blank
 * shots), no AI. Exit 1 when any error-severity finding or route failure
 * surfaced, so callers can gate on it.
 */
import { assertTargetsAllowed, loadConfig } from "../config.js";
import { preflight, requireUp, resolveTargets } from "../targets.js";
import { captureWeb, type WebCaptureOptions } from "../capture/web.js";
import { mergeRun } from "../capture/store.js";
import type { FormFactor, Scheme } from "../types.js";
import { LookoutError } from "../types.js";
import { list, num, printJson, runId, str, type Parsed } from "../util.js";

const FORM_FACTORS: FormFactor[] = ["desktop", "tablet", "phone"];
const SCHEMES: Scheme[] = ["dark", "light"];

export interface CaptureOutcome {
  runId: string;
  shots: number;
  findings: { errors: number; warnings: number; infos: number };
  failures: { target: string; route: string; step: string; message: string }[];
  reportPath: string;
  evidenceDir: string;
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

  const { run, shots } = await captureWeb(resolved, targets, opts);
  await mergeRun(resolved, run, shots);

  const all = shots.flatMap((s) => s.deterministicFindings);
  const outcome: CaptureOutcome = {
    runId: run.id,
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
  const { outcome } = await runCapture(parsed);

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
  }
  return outcome.failures.length > 0 || outcome.findings.errors > 0 ? 1 : 0;
}
