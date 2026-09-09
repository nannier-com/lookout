/**
 * Evidence store: where shots and the capture report live for a project.
 *
 * Layout under the project's capture workspace (evidenceDir: a per-project
 * directory in the operator's lookout home, not inside the judged project):
 *   capture-report.json
 *   <platform>/<target>/<route-slug>/<state>--<formFactor>-<scheme>.png
 *
 * The form factor is in every platform's filename: a phone and a tablet shot
 * of one route on one platform are two files, never one overwriting the other.
 *
 * Filenames are stable so re-runs overwrite in place and the report's shot ids
 * stay the dedupe key.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { atomicWriteJson } from "../state/atomic.js";
import { withProjectLock, withStateLock } from "../state/lock.js";
import {
  canonicalShotId,
  canonicalShotRelPath,
  legacyRouteSlug,
  legacyShotId,
  legacyShotRelPath,
  routeToken,
} from "./route-identity.js";

export interface ShotAxes {
  target: string;
  route: string; // path, e.g. /settings
  state: string; // "rest" or a recipe name
  platform: PlatformKind;
  formFactor: FormFactor;
  scheme: Scheme;
}

/** The canonical filesystem token for a route. */
export function routeSlug(route: string): string {
  return routeToken(route);
}

export { legacyRouteSlug } from "./route-identity.js";

export function shotId(a: ShotAxes): string {
  return canonicalShotId(a);
}

/** Path relative to the evidence dir. */
export function shotRelPath(a: ShotAxes): string {
  return canonicalShotRelPath(a);
}

export function reportPath(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "capture-report.json");
}

export async function loadReport(
  resolved: ResolvedConfig,
  opts: { preservePaths?: ReadonlySet<string> } = {},
): Promise<CaptureReport | null> {
  const p = reportPath(resolved);
  const parsed = await readReportFile(p);
  if (!parsed) return null;
  if (parsed.version !== 1) return null; // future versions rebuild from scratch
  if (parsed.routeIdentity === 2) return parsed;
  return withProjectLock(resolved, "capture report migration", async () =>
    withStateLock(resolved, "report", async () => {
      const current = await readReportFile(p);
      if (!current || current.version !== 1) return null;
      if (current.routeIdentity === 2) return current;
      return migrateReportRouteIdentity(resolved, current, p, opts.preservePaths ?? new Set());
    }));
}

async function readReportFile(path: string): Promise<CaptureReport | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as CaptureReport;
}

function ambiguousLegacyRoutes(resolved: ResolvedConfig, report: CaptureReport): Set<string> {
  const routes = new Map<string, Set<string>>();
  const add = (target: string, route: string): void => {
    const key = `${target}\u0000${legacyRouteSlug(route)}`;
    const values = routes.get(key) ?? new Set<string>();
    values.add(route.startsWith("/") ? route : `/${route}`);
    routes.set(key, values);
  };
  const targets = Array.isArray(resolved.config.targets) ? resolved.config.targets : [];
  for (const target of targets) {
    for (const raw of target.routes?.length ? target.routes : ["/"]) {
      add(target.name, typeof raw === "string" ? raw : raw.path);
    }
  }
  for (const shot of report.shots) add(shot.target, shot.route);
  return new Set([...routes].filter(([, values]) => values.size > 1).map(([key]) => key));
}

async function moveIfPresent(from: string, to: string, preserveDestination = false): Promise<void> {
  if (!existsSync(from) || from === to) return;
  await mkdir(dirname(to), { recursive: true });
  if (preserveDestination && existsSync(to)) {
    await rm(from, { force: true });
    return;
  }
  await rm(to, { force: true });
  await rename(from, to);
}

async function migrateReportRouteIdentity(
  resolved: ResolvedConfig,
  report: CaptureReport,
  path: string,
  preservePaths: ReadonlySet<string>,
): Promise<CaptureReport> {
  if (report.routeIdentity === 2) return report;
  const ambiguous = ambiguousLegacyRoutes(resolved, report);
  const root = evidenceDir(resolved);
  const migrated: ShotRecord[] = [];
  let changed = false;

  for (const shot of report.shots) {
    const oldId = legacyShotId(shot);
    const oldPath = legacyShotRelPath(shot);
    const canonicalId = canonicalShotId(shot);
    const canonicalPath = canonicalShotRelPath(shot);
    const legacy = shot.id === oldId || shot.path === oldPath;
    const ambiguousKey = `${shot.target}\u0000${legacyRouteSlug(shot.route)}`;
    if (legacy && ambiguous.has(ambiguousKey)) {
      for (const rel of [oldPath, `${oldPath}.provenance.json`, `${oldPath}.aria.json`]) {
        if (!preservePaths.has(rel)) await rm(join(root, rel), { force: true });
      }
      changed = true;
      continue;
    }
    if (shot.id === canonicalId && shot.path === canonicalPath) {
      migrated.push(shot);
      continue;
    }

    await moveIfPresent(join(root, shot.path), join(root, canonicalPath), preservePaths.has(canonicalPath));
    const next: ShotRecord = { ...shot, id: canonicalId, path: canonicalPath };
    if (shot.provenance) {
      const nextRel = `${canonicalPath}.provenance.json`;
      await moveIfPresent(join(root, shot.provenance), join(root, nextRel), preservePaths.has(nextRel));
      next.provenance = nextRel;
    }
    if (shot.aria) {
      const nextRel = `${canonicalPath}.aria.json`;
      await moveIfPresent(join(root, shot.aria), join(root, nextRel), preservePaths.has(nextRel));
      next.aria = nextRel;
    }
    migrated.push(next);
    changed = true;
  }

  const next: CaptureReport = {
    ...report,
    routeIdentity: 2,
    shots: migrated,
    ...(changed ? { updatedAt: nowIso() } : {}),
  };
  await atomicWriteJson(path, next);
  if (changed) {
    await rm(join(root, "judge-report.json"), { force: true });
    await rm(join(root, "judge-replies"), { recursive: true, force: true });
  }
  return next;
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
  return withProjectLock(resolved, "capture report update", async () =>
    withStateLock(resolved, "report", async () => mergeRunLocked(resolved, run, shots, opts)));
}

async function mergeRunLocked(
  resolved: ResolvedConfig,
  run: RunRecord,
  shots: ShotRecord[],
  opts: NonNullable<Parameters<typeof mergeRun>[3]>,
): Promise<{ report: CaptureReport; pruned: number }> {
  const preservePaths = new Set(
    shots.flatMap((shot) => [shot.path, shot.provenance, shot.aria].filter((p): p is string => !!p)),
  );
  const existing = (await loadReport(resolved, { preservePaths })) ?? {
    version: 1 as const,
    routeIdentity: 2 as const,
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
    routeIdentity: 2,
    project: resolved.project,
    updatedAt: nowIso(),
    // Keep the last 20 runs of history. A run merged in pieces (a screen walk
    // merges each screen as it lands, all under one run id) replaces its own
    // entry rather than appearing once per piece.
    runs: [...existing.runs.filter((r) => r.id !== run.id).slice(-19), run],
    shots: kept,
  };
  const p = reportPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteJson(p, report);
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

/**
 * The provenance sidecar beside a shot: the PNG path plus a suffix, so the
 * pairing is self-evident in a directory listing and the sidecar inherits the
 * PNG's overwrite-in-place lifecycle. This is the one place the convention
 * lives on the write side.
 */
export function sidecarRelPath(a: ShotAxes): string {
  return `${shotRelPath(a)}.provenance.json`;
}

/** The accessibility-tree sidecar beside a shot, by the same convention. */
export function ariaRelPath(a: ShotAxes): string {
  return `${shotRelPath(a)}.aria.json`;
}

export async function writeShotAria(
  resolved: ResolvedConfig,
  axes: ShotAxes,
  sidecar: unknown,
): Promise<{ rel: string; abs: string }> {
  const rel = ariaRelPath(axes);
  const abs = join(evidenceDir(resolved), rel);
  await mkdir(dirname(abs), { recursive: true });
  await atomicWriteJson(abs, sidecar);
  return { rel, abs };
}

export async function writeShotSidecar(
  resolved: ResolvedConfig,
  axes: ShotAxes,
  sidecar: unknown,
): Promise<{ rel: string; abs: string }> {
  const rel = sidecarRelPath(axes);
  const abs = join(evidenceDir(resolved), rel);
  await mkdir(dirname(abs), { recursive: true });
  await atomicWriteJson(abs, sidecar);
  return { rel, abs };
}
