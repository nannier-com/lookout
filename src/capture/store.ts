/**
 * Evidence store: where shots and the capture report live for a project.
 *
 * Layout under the project's capture workspace (evidenceDir: a per-project
 * directory in the operator's lookout home, not inside the judged project):
 *   capture-report.json
 *   web/<target>/<route-slug>/<state>--<formFactor>-<scheme>.png
 *   ios|android/<target>/<route-slug>/<state>--<scheme>.png
 *
 * Filenames are stable so re-runs overwrite in place and the report's shot ids
 * stay the dedupe key.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CaptureReport,
  FormFactor,
  PlatformKind,
  ResolvedConfig,
  RunRecord,
  Scheme,
  ShotRecord,
} from "../types.js";
import { evidenceDir } from "../config.js";
import { nowIso } from "../util.js";

export interface ShotAxes {
  target: string;
  route: string; // path, e.g. /settings
  state: string; // "rest" or a recipe name
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
}

/** "/settings/profile" -> "settings-profile"; "/" -> "root". */
export function routeSlug(route: string): string {
  const s = route.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  return s || "root";
}

export function shotId(a: ShotAxes): string {
  return [a.platform, a.target, routeSlug(a.route), a.state, a.formFactor, a.scheme].join("/");
}

/** Path relative to the evidence dir. */
export function shotRelPath(a: ShotAxes): string {
  const ff = a.platform === "web" ? `${a.formFactor}-` : "";
  return join(a.platform, a.target, routeSlug(a.route), `${a.state}--${ff}${a.scheme}.png`);
}

export function reportPath(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "capture-report.json");
}

export async function loadReport(resolved: ResolvedConfig): Promise<CaptureReport | null> {
  const p = reportPath(resolved);
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(await readFile(p, "utf8")) as CaptureReport;
  if (parsed.version !== 1) return null; // future versions rebuild from scratch
  return parsed;
}

/**
 * Merge a finished run into the report: shots replace same-id records, the run
 * appends. Atomic tmp+rename so a crash never leaves a torn report.
 */
export async function mergeRun(
  resolved: ResolvedConfig,
  run: RunRecord,
  shots: ShotRecord[],
  opts: {
    /**
     * The full config's targets, passed only by an UNSCOPED capture: web
     * shots no longer describing a configured route/state are dropped from
     * the report. A scoped capture cannot see the whole config's intent, so
     * it never prunes.
     */
    pruneNotIn?: import("../targets.js").ResolvedTarget[];
    /** Synthesized states navigation.json still names, per target|route key. */
    plannedStates?: ReadonlyMap<string, ReadonlySet<string>>;
  } = {},
): Promise<{ report: CaptureReport; pruned: number }> {
  const existing = (await loadReport(resolved)) ?? {
    version: 1 as const,
    project: resolved.project,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    runs: [],
    shots: [],
  };
  const ids = new Set(shots.map((s) => s.id));
  let kept = [...existing.shots.filter((s) => !ids.has(s.id)), ...shots];
  let pruned = 0;
  if (opts.pruneNotIn) {
    const { shotInConfig } = await import("../targets.js");
    const before = kept.length;
    kept = kept.filter((s) => shotInConfig(s, opts.pruneNotIn!, opts.plannedStates));
    pruned = before - kept.length;
  }
  const report: CaptureReport = {
    ...existing,
    project: resolved.project,
    updatedAt: nowIso(),
    runs: [...existing.runs.slice(-19), run], // keep the last 20 runs of history
    shots: kept,
  };
  const p = reportPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 2));
  await rename(tmp, p);
  return { report, pruned };
}

export async function writeShotFile(
  resolved: ResolvedConfig,
  axes: ShotAxes,
  png: Buffer | Uint8Array,
): Promise<{ rel: string; abs: string }> {
  const rel = shotRelPath(axes);
  const abs = join(evidenceDir(resolved), rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, png);
  return { rel, abs };
}
