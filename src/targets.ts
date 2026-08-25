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
import { probe } from "./util.js";

export interface ResolvedRoute {
  path: string;
  name: string;
  url: string;
  states: string[];
  element?: string;
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
export function resolveRoutes(target: TargetDef, defaultElement?: string): ResolvedRoute[] {
  const raw = target.routes && target.routes.length > 0 ? target.routes : ["/"];
  return raw.map((r) => {
    const def: RouteDef = typeof r === "string" ? { path: r } : r;
    const path = def.path.startsWith("/") ? def.path : `/${def.path}`;
    return {
      path,
      name: def.name ?? path,
      url: `${target.url}${path === "/" ? "" : path}`,
      states: def.states ?? [],
      element: def.element ?? defaultElement,
    };
  });
}

/** Filter config targets by --targets and resolve their routes. */
export function resolveTargets(
  config: LookoutConfig,
  only?: string[],
  routesFilter?: string[],
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
  return defs.map((def) => {
    let routes = resolveRoutes(def, config.element);
    if (routesFilter && routesFilter.length > 0) {
      routes = routes.filter((r) =>
        routesFilter.some((f) => r.path === f || r.path === `/${f}` || r.name === f),
      );
      if (routes.length === 0) {
        throw new LookoutError(
          `--routes matched nothing on target "${def.name}"`,
          `its routes: ${resolveRoutes(def).map((r) => r.path).join(", ")}`,
        );
      }
    }
    return { def, routes };
  });
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

/** Throw with start instructions when any requested target is down. */
export function requireUp(statuses: TargetStatus[]): void {
  const down = statuses.filter((s) => !s.up);
  if (down.length === 0) return;
  const lines = down.map(
    (s) =>
      `  ${s.name}: ${s.url} is not responding` +
      (s.startHint ? `\n    start it: ${s.startHint}` : ""),
  );
  throw new LookoutError(
    `target(s) not reachable:\n${lines.join("\n")}`,
    "lookout never starts services itself; start the app, then re-run",
  );
}
