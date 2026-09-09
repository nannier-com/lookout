/**
 * Whether this check walks the map, and with what. The only file under
 * `check/` that imports the map's store and the navigator's reach layer, so
 * a check with no map never loads either.
 */
import { ensureMap, type EnsuredMap } from "../map/ensure.js";
import { reachScreen, replayScreen } from "../navigator/reach.js";
import type { MapFile } from "../map/store.js";
import type { ResolvedConfig } from "../types.js";
import { list, str, type Parsed } from "../util.js";
import { mapWriter, type WalkSeams } from "./walk-reach.js";

export interface WalkPlan {
  map: MapFile;
  ensured: EnsuredMap;
  seams: WalkSeams;
}

/**
 * The map to walk, or null when this run captures the matrix: `--no-map`,
 * `--no-capture` (nothing to reach), a zero-config run, or no map on disk
 * and no consent to scan for one.
 */
export async function mapToWalk(parsed: Parsed, pre: ResolvedConfig, log: (line: string) => void): Promise<WalkPlan | null> {
  if (parsed.flags["no-map"] || parsed.flags["no-capture"] || !pre.configPath) return null;
  const ensured = await ensureMap(pre, parsed.flags, { targets: list(parsed.flags.targets), model: str(parsed.flags.model), log });
  if (!ensured.map) return null;
  return { map: ensured.map, ensured, seams: { reachScreen, replayScreen, recordReach: mapWriter(pre) } };
}
