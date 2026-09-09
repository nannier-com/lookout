/**
 * The map as configured intent: what it puts in scope, and how a discovered
 * route becomes a target a capture can be pointed at.
 *
 * The config is the operator's declared truth and the map extends it. A
 * screen the map found beyond `lookout.config.ts` is judged, kept, and can be
 * named by `--routes`, without lookout ever editing the config: the extension
 * happens in memory, on the way into `resolveTargets`, and nowhere else.
 */
import { resolveTargets, type ResolvedTarget } from "../targets.js";
import { routeKey, validStateName } from "../navigate/store.js";
import type { LookoutConfig, ResolvedConfig, RouteDef } from "../types.js";
import { loadMap, walkNodes, type MapFile } from "./store.js";

export interface MappedIndex {
  /** Per target: every route node's path, configured or discovered. */
  routes: Map<string, Set<string>>;
  /** Per `target|route`: the state ids the map files under that route. */
  states: Map<string, Set<string>>;
}

function add(index: Map<string, Set<string>>, key: string, value: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(value);
  index.set(key, set);
}

/**
 * What the map puts in scope, or undefined when there is no map or the
 * project switched it off. Hand-written recipes win a name collision, as they
 * do for navigation-planned states.
 */
export async function mappedIndex(resolved: ResolvedConfig): Promise<MappedIndex | undefined> {
  if (resolved.config.map?.enabled === false) return undefined;
  const map = await loadMap(resolved);
  if (!map) return undefined;
  return indexOf(map, new Set(Object.keys(resolved.config.states ?? {})));
}

export function indexOf(map: MapFile, recipeNames: ReadonlySet<string>): MappedIndex {
  const routes = new Map<string, Set<string>>();
  const states = new Map<string, Set<string>>();
  for (const [target, t] of Object.entries(map.targets)) {
    walkNodes(t.roots, (node, routeAncestor) => {
      if (node.kind === "route" && node.path) {
        add(routes, target, node.path);
      } else if (node.kind === "state" && validStateName(node.id) && !recipeNames.has(node.id)) {
        add(states, routeKey(target, routeAncestor.path ?? routeAncestor.id), node.id);
      }
    });
  }
  return { routes, states };
}

/**
 * The config with the map's discovered routes added to its targets, in
 * memory. Pure: the input is never mutated and nothing is written. A route
 * the config already lists keeps the config's definition.
 */
export function mapAugmentedConfig(config: LookoutConfig, map: MapFile): LookoutConfig {
  return {
    ...config,
    targets: config.targets.map((target) => {
      const mapped = map.targets[target.name];
      if (!mapped) return target;
      const base: (string | RouteDef)[] = target.routes && target.routes.length > 0 ? [...target.routes] : ["/"];
      const known = new Set(base.map((r) => normalize(typeof r === "string" ? r : r.path)));
      const extra: RouteDef[] = [];
      walkNodes(mapped.roots, (node) => {
        if (node.kind !== "route" || !node.path) return;
        const path = normalize(node.path);
        if (known.has(path)) return;
        known.add(path);
        extra.push({ path, name: node.title, platforms: node.platforms });
      });
      return extra.length > 0 ? { ...target, routes: [...base, ...extra] } : target;
    }),
  };
}

function normalize(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

/**
 * `resolveTargets` over the config as the map extends it. `useMap: false` is
 * the config alone, for a run that opted out of the map.
 */
export async function resolveMappedTargets(
  resolved: ResolvedConfig,
  only?: string[],
  routesFilter?: string[],
  opts: { useMap?: boolean } = {},
): Promise<ResolvedTarget[]> {
  const map = opts.useMap === false || resolved.config.map?.enabled === false ? null : await loadMap(resolved);
  const config = map ? mapAugmentedConfig(resolved.config, map) : resolved.config;
  return resolveTargets(config, only, routesFilter, resolved.configPath);
}
