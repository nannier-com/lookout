/**
 * Target and route resolution plus reachability preflight.
 *
 * lookout never starts services. When a target is down it reports the fact and
 * prints the target's startHint so the operator (human or agent) starts it the
 * way that project intends.
 */
import {
  LookoutError,
  type LookoutConfig,
  type RouteDef,
  type TargetDef,
} from "./types.js";
import { dirname, resolve } from "node:path";
import { probe } from "./util.js";

export interface ResolvedRoute {
  path: string;
  name: string;
  url: string;
  states: string[];
  element?: string;
  /** Absolute path of the route's design hand-off image, when configured. */
  design?: string;
}

export interface ResolvedTarget {
  def: TargetDef;
  routes: ResolvedRoute[];
}

export interface TargetStatus {
  name: string;
  url: string;
  routes: number;
  up: boolean;
  status: number | null;
  startHint?: string;
}

/** Normalize a target's routes ("/x" strings and RouteDef objects) to one shape. */
export function resolveRoutes(
  target: TargetDef,
  defaultElement?: string,
  /** Config file path; design references resolve relative to it. */
  designBase?: string | null,
): ResolvedRoute[] {
  const raw = target.routes && target.routes.length > 0 ? target.routes : ["/"];
  return raw.map((r) => {
    const def: RouteDef = typeof r === "string" ? { path: r } : r;
    const path = def.path.startsWith("/") ? def.path : `/${def.path}`;
    let url = `${target.url}${path === "/" ? "" : path}`;
    if (target.query && Object.keys(target.query).length > 0) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(target.query)) u.searchParams.set(k, v);
      url = u.toString();
    }
    return {
      path,
      name: def.name ?? path,
      url,
      states: def.states ?? [],
      element: def.element ?? defaultElement,
      design: def.design
        ? designBase
          ? resolve(dirname(designBase), def.design)
          : def.design
        : undefined,
    };
  });
}

/** Filter config targets by --targets and resolve their routes. */
export function resolveTargets(
  config: LookoutConfig,
  only?: string[],
  routesFilter?: string[],
  /** Config file path; route design references resolve relative to it. */
  configPath?: string | null,
): ResolvedTarget[] {
  let defs = config.targets;
  if (only && only.length > 0) {
    const known = new Set(defs.map((t) => t.name));
    for (const name of only) {
      if (!known.has(name)) {
        throw new LookoutError(
          `unknown target "${name}"`,
          `configured targets: ${[...known].join(", ")}`,
        );
      }
    }
    defs = defs.filter((t) => only.includes(t.name));
  }
  const resolved = defs.map((def) => {
    let routes = resolveRoutes(def, config.element, configPath);
    if (routesFilter && routesFilter.length > 0) {
      routes = routes.filter((r) =>
        routesFilter.some((f) => r.path === f || r.path === `/${f}` || r.name === f),
      );
    }
    return { def, routes };
  });
  if (routesFilter && routesFilter.length > 0) {
    // A route filter narrows across targets: targets it misses entirely drop
    // out; only a filter matching NOTHING anywhere is an error.
    const withRoutes = resolved.filter((t) => t.routes.length > 0);
    if (withRoutes.length === 0) {
      const all = defs.flatMap((d) => resolveRoutes(d).map((r) => `${d.name}:${r.path}`));
      throw new LookoutError(
        `--routes matched nothing on any selected target`,
        `available: ${all.slice(0, 20).join(", ")}${all.length > 20 ? ", ..." : ""}`,
      );
    }
    return withRoutes;
  }
  return resolved;
}

/** Probe each target's readyPath. Never starts anything. */
export async function preflight(targets: ResolvedTarget[]): Promise<TargetStatus[]> {
  return Promise.all(
    targets.map(async ({ def, routes }) => {
      const ready = `${def.url}${def.readyPath ?? "/"}`;
      const status = await probe(ready);
      return {
        name: def.name,
        url: def.url,
        routes: routes.length,
        up: status !== null && status < 500,
        status,
        startHint: def.startHint,
      };
    }),
  );
}

/**
 * Why the requested targets cannot be captured, or null when they all can.
 *
 * Shared so the CLI and the UI say the same thing about the same state. The UI
 * needs this as a value rather than a throw: it refuses to spawn a doomed run
 * and shows the reason, where before it spawned one and discarded the stderr
 * that would have explained it.
 */
export function downReason(statuses: TargetStatus[]): string | null {
  const down = statuses.filter((s) => !s.up);
  if (down.length === 0) return null;
  const lines = down.map(
    (s) =>
      `  ${s.name}: ${s.url} is not responding` +
      (s.status !== null ? ` (HTTP ${s.status})` : "") +
      (s.startHint ? `\n    start it: ${s.startHint}` : ""),
  );
  return `target(s) not reachable:\n${lines.join("\n")}`;
}

/** Throw with start instructions when any requested target is down. */
export function requireUp(statuses: TargetStatus[]): void {
  const reason = downReason(statuses);
  if (!reason) return;
  throw new LookoutError(
    reason,
    "lookout never starts services itself; start the app, then re-run",
  );
}


/**
 * Whether a stored shot still describes something the current config asks
 * for. The capture report accumulates across runs and replaces only same-id
 * shots, so a route or state removed from the config would otherwise be
 * judged (and its findings refreshed) forever. Web only: native target
 * resolution is a different shape, and a conservative predicate that never
 * prunes a native shot beats one that guesses.
 *
 * `plannedStates` is navigation discovery's slice of configured intent: the
 * synthesized states `.lookout/navigation.json` currently names per
 * `target|route` key. A state a plan stopped naming is retired here exactly
 * like one removed from a route's `states`.
 */
export function shotInConfig(
  shot: { platform: string; target: string; route: string; state: string },
  targets: ResolvedTarget[],
  plannedStates?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (shot.platform !== "web") return true;
  const t = targets.find((x) => x.def.name === shot.target);
  if (!t) return false;
  const r = t.routes.find((x) => x.path === shot.route);
  if (!r) return false;
  return (
    shot.state === "rest" ||
    r.states.includes(shot.state) ||
    (plannedStates?.get(`${shot.target}|${shot.route}`)?.has(shot.state) ?? false)
  );
}
