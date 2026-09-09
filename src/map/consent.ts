/**
 * Who said a run may walk the map, and who said it may spend a scan.
 *
 * A map is walked whenever one exists: `lookout map` was the consent, the way
 * writing `navigation.enabled` is. `--no-map` opts one run out. Refreshing a
 * missing or stale map from inside `check` is a different spend (a source
 * scan, on every fix iteration of a --first loop if it were automatic), so it
 * takes its own yes: `--map` for one run, or `map: { enabled: true }` for the
 * project. `map: { enabled: false }` says never, whatever the file on disk.
 */
import type { LookoutConfig } from "../types.js";

export function mapOn(config: LookoutConfig, flags: Record<string, string | boolean>): boolean {
  if (flags["no-map"]) return false;
  return config.map?.enabled !== false;
}

export function mapRefreshOn(config: LookoutConfig, flags: Record<string, string | boolean>): boolean {
  return mapOn(config, flags) && (config.map?.enabled === true || !!flags.map);
}
