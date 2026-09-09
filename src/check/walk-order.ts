/**
 * The order a walk visits the map's screens in. Pure, so a test can pin it.
 *
 * Route by route, in the order `check --first` walks routes (routes ruled
 * fully fixed first as the regression net, then routes with open findings
 * worst first, then the map's order), and within a route in the map's own
 * order: parent before child, safe siblings before destructive ones, which
 * is how the parser stored them. A screen's shots file under the nearest
 * route above it, so the route order is what decides whether a defect's
 * screen is reached before the stop rule ends a `--first` run.
 */
import { orderStops } from "./first.js";
import { validStateName } from "../navigate/store.js";
import type { BacklogFinding } from "../backlog/lib.js";
import type { MapFile, MapNode, MapRisk } from "../map/store.js";
import type { Screen } from "../navigator/reach.js";
import { LookoutError, type PlatformKind } from "../types.js";

export interface ScreenStop extends Screen {
  risk: MapRisk;
}

export interface WalkScope {
  targets?: string[];
  routes?: string[];
  /** Exact screen ids, `target|route|state`. */
  screens?: string[];
  /** The platforms this run walks; a screen on none of them is skipped. */
  platforms: PlatformKind[];
}

export interface Skipped {
  id: string;
  reason: string;
}

/** Every screen of the map, pre-order, each with the state ancestors it is reached through. */
export function flattenScreens(map: MapFile, platforms: PlatformKind[]): { stops: ScreenStop[]; skipped: Skipped[] } {
  const stops: ScreenStop[] = [];
  const skipped: Skipped[] = [];
  const visit = (target: string, node: MapNode, route: MapNode | null, chain: MapNode[]): void => {
    const routeNode = node.kind === "route" ? node : route;
    if (!routeNode) return;
    const routePath = routeNode.path ?? routeNode.id;
    const state = node.kind === "route" ? "rest" : node.id;
    const id = `${target}|${routePath}|${state}`;
    const on = node.platforms.filter((p) => platforms.includes(p));
    if (node.kind === "state" && !validStateName(node.id)) {
      skipped.push({ id, reason: "invalid state name" });
    } else if (on.length === 0) {
      skipped.push({ id, reason: "no platform in this run" });
    } else {
      stops.push({
        id,
        target,
        route: routePath,
        routeName: routeNode.title,
        state,
        node,
        chain: node.kind === "route" ? [] : [...chain],
        platforms: on,
        allowDestructive: node.risk !== "safe",
        risk: node.risk,
      });
    }
    const nextChain = node.kind === "route" ? [] : [...chain, node];
    for (const child of node.children) visit(target, child, routeNode, nextChain);
  };
  for (const [target, t] of Object.entries(map.targets)) {
    for (const root of t.roots) visit(target, root, null, []);
  }
  return { stops, skipped };
}

function routeMatches(stop: ScreenStop, wanted: readonly string[]): boolean {
  return wanted.some((r) => stop.route === r || stop.route === `/${r}` || stop.routeName === r);
}

/**
 * The stops a run walks, in order. `--targets`, `--routes` and `--screens`
 * narrow it; a selector that matches nothing is refused, because reporting
 * "clean" for a screen nobody looked at would be a lie.
 */
export function orderScreens(
  map: MapFile,
  findings: readonly Pick<BacklogFinding, "target" | "route" | "severity" | "status" | "channel">[],
  scope: WalkScope,
): { stops: ScreenStop[]; skipped: Skipped[] } {
  const flat = flattenScreens(map, scope.platforms);
  let stops = flat.stops;
  if (scope.targets) {
    const known = new Set(Object.keys(map.targets));
    for (const t of scope.targets) {
      if (!known.has(t)) throw new LookoutError(`unknown target "${t}"`, `the map covers: ${[...known].join(", ")}`);
    }
    stops = stops.filter((s) => scope.targets!.includes(s.target));
  }
  if (scope.routes) stops = stops.filter((s) => routeMatches(s, scope.routes!));
  if (scope.screens) {
    const known = new Set(flat.stops.map((s) => s.id));
    for (const id of scope.screens) {
      if (!known.has(id)) {
        throw new LookoutError(`unknown screen "${id}"`, `the map has: ${[...known].slice(0, 20).join(", ")}${known.size > 20 ? ", ..." : ""}`);
      }
    }
    stops = stops.filter((s) => scope.screens!.includes(s.id));
  }
  if (stops.length === 0) throw new LookoutError("no mapped screens match the given --targets/--routes/--screens");

  // Route order from the first-issue walk's rule, applied to the routes the
  // stops belong to; each route's screens stay together and in map order.
  const routeStops: { target: string; route: string }[] = [];
  const seen = new Set<string>();
  for (const s of stops) {
    const key = `${s.target}|${s.route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routeStops.push({ target: s.target, route: s.route });
  }
  const order = new Map(orderStops(routeStops, findings).map((r, i) => [`${r.target}|${r.route}`, i]));
  const indexed = stops.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => order.get(`${a.s.target}|${a.s.route}`)! - order.get(`${b.s.target}|${b.s.route}`)! || a.i - b.i);
  return { stops: indexed.map((x) => x.s), skipped: flat.skipped };
}
