/**
 * The map a `check` walks, if any: read from disk, refreshed when the run
 * consented to a scan, warned about when stale.
 *
 * `check` never scans on its own say-so. A source scan is a different spend
 * from a judge call, and it would otherwise land on every iteration of a
 * `--first` fix loop; a stale map is still mostly right, and the walk writes
 * down what it could not reach. So a missing map means the matrix (with a
 * one-line hint), a stale map is walked with a warning, and only `--map` or
 * `map: { enabled: true }` turns either into a scan.
 */
import { emit } from "../report/events.js";
import { loadSkill } from "../skills/load.js";
import { repoRootOf } from "../design/detect.js";
import { hashText } from "../design/conformance-cache.js";
import { resolveRoutes } from "../targets.js";
import type { ResolvedConfig } from "../types.js";
import { join } from "node:path";
import { mapCandidates } from "./candidates.js";
import { mapOn, mapRefreshOn } from "./consent.js";
import { readTextFromDisk } from "./parse-node.js";
import { runMap } from "./run.js";
import { mapFreshness } from "./signature.js";
import { DEFAULT_MAP_FILE_BUDGET, loadMap, type MapFile } from "./store.js";

export interface EnsuredMap {
  /** The map to walk, or null when this run captures the matrix instead. */
  map: MapFile | null;
  /** Targets whose map was stale and is being walked anyway, with the reason. */
  stale: { target: string; reasons: string[] }[];
  /** Targets refreshed by this call. */
  refreshed: string[];
  costUsd: number;
}

/** Which selected targets have a stale or missing map, and why. */
export async function staleTargets(
  resolved: ResolvedConfig,
  map: MapFile | null,
  targets: readonly string[],
): Promise<{ target: string; reasons: string[] }[]> {
  const skill = await loadSkill(resolved, "map-screens");
  const repoRoot = await repoRootOf(resolved.projectDir);
  const candidates = await mapCandidates(resolved, resolved.config.map?.fileBudget ?? DEFAULT_MAP_FILE_BUDGET);
  const hashOf = (rel: string): string | null => {
    const text = readTextFromDisk(join(repoRoot, rel));
    return text === null ? null : hashText(text);
  };
  const out: { target: string; reasons: string[] }[] = [];
  for (const def of resolved.config.targets) {
    if (!targets.includes(def.name)) continue;
    const routes = resolveRoutes(def, resolved.config.element, resolved.configPath);
    const f = mapFreshness({
      target: map?.targets[def.name],
      targetName: def.name,
      skill,
      configSlice: { url: def.url, routes: routes.map((r) => ({ path: r.path, states: r.states })) },
      candidates,
      hashOf,
    });
    if (!f.fresh) out.push({ target: def.name, reasons: f.reasons });
  }
  return out;
}

export async function ensureMap(
  resolved: ResolvedConfig,
  flags: Record<string, string | boolean>,
  opts: { targets?: string[]; model?: string; log: (line: string) => void },
): Promise<EnsuredMap> {
  const none: EnsuredMap = { map: null, stale: [], refreshed: [], costUsd: 0 };
  if (!mapOn(resolved.config, flags)) return none;
  const selected = opts.targets ?? resolved.config.targets.map((t) => t.name);
  let map = await loadMap(resolved);
  const missing = selected.filter((name) => !map?.targets[name]);
  const stale = await staleTargets(resolved, map, selected);

  if (mapRefreshOn(resolved.config, flags) && stale.length > 0) {
    const run = await runMap(resolved, {
      targets: stale.map((s) => s.target),
      model: opts.model,
      log: opts.log,
    });
    map = run.file;
    const refreshed = run.targets.filter((t) => t.status === "scanned").map((t) => t.name);
    const stillMissing = selected.filter((name) => !map?.targets[name]);
    return {
      map: stillMissing.length === selected.length ? null : map,
      stale: stale.filter((s) => !refreshed.includes(s.target) && map?.targets[s.target]),
      refreshed,
      costUsd: run.costUsd,
    };
  }

  if (missing.length === selected.length) {
    if (map === null) opts.log("map: no screen map; capturing the matrix (run `lookout map`, or pass --map)");
    return none;
  }
  const walkedStale = stale.filter((s) => !missing.includes(s.target));
  for (const s of walkedStale) {
    const line = `the screen map for ${s.target} is stale: ${s.reasons.join(", ")}; walking it anyway (run lookout map)`;
    opts.log(`map: ${line}`);
    emit("note", line, { stale: true, target: s.target, reasons: s.reasons });
  }
  for (const name of missing) {
    opts.log(`map: no screen map for ${name}; its configured routes are walked at rest`);
  }
  return { map, stale: walkedStale, refreshed: [], costUsd: 0 };
}
