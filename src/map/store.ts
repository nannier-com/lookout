/**
 * The screen map: what screens an application has and how each is reached,
 * read from its source once and kept at `.lookout/map.json`.
 *
 * A node is a route (reached by URL, walked as the `rest` state) or a state
 * (reached by an action on its parent, walked under the nearest route above
 * it). The file is what `lookout map` writes and what `check` walks; the
 * walk writes back, under `walk`, what it managed to reach and how, and a
 * re-scan carries that forward so a map refreshed for one new screen does
 * not forget how it reached the others.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import { atomicWriteJson } from "../state/atomic.js";
import { withStateLock } from "../state/lock.js";
import type { NavRisk } from "../navigate/store.js";
import type { NavAction } from "../mcp/actions.js";
import type { PlatformKind, ResolvedConfig } from "../types.js";

/** Nodes per target, levels below a root, children per node, files offered to the reader. */
export const DEFAULT_MAX_SCREENS = 40;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_CHILDREN = 8;
export const DEFAULT_MAP_FILE_BUDGET = 60;

/** How a screen is reached. Focus and hover are indicators, not screens. */
export type MapOutcome = "navigation" | "overlay" | "in-page-change";
export type MapRisk = NavRisk;

/** Where in the source a node was read from. The path is absolute and was verified to exist. */
export interface MapSource {
  path: string;
  line?: number;
  symbol?: string;
}

export interface MapOpen {
  /** Web: the control on the parent screen, resolved live by role and name; selector and href are hints. */
  affordance?: { role: string; name: string; selector?: string; href?: string };
  /** Route nodes: navigation. State nodes: overlay or in-page-change. */
  outcome: MapOutcome;
  /** Devices: the deep-link path; the scheme comes from native.<os>.deepLinkScheme. */
  deepLink?: string;
  /** Devices: the label to tap when there is no deep link. */
  tap?: { label: string };
}

/** What the walk learned about a node. Written only by the walk, never by `lookout map`. */
export interface MapWalk {
  reached: boolean;
  verifiedAt?: string;
  /** The actions that reached it, for replay without a navigator. */
  actions?: NavAction[];
  shotIds?: string[];
}

export interface MapNode {
  /** A route node's id is its path; a state node's is a state name, unique under its route. */
  id: string;
  kind: "route" | "state";
  /** Route nodes only: leading slash, concrete (no parameters). */
  path?: string;
  title: string;
  /** Null when the node is reached by URL: a root, or a discovered route nobody links to. */
  open: MapOpen | null;
  /** Effective: the highest of its own and every ancestor's. */
  risk: MapRisk;
  /** A subset of the project's fold; never empty. */
  platforms: PlatformKind[];
  source: MapSource;
  why: string;
  children: MapNode[];
  walk?: MapWalk;
}

export interface MapTarget {
  /** The target's url at scan time; informational, resolution uses the live config. */
  url: string;
  mappedAt: string;
  skillVersion: number;
  ai: string;
  model: string;
  /** What the map was derived from; `mapFreshness` recomputes it. */
  signature: string;
  /** Repo-relative, sorted: the files the reader examined, with their content hashes. */
  examined: { path: string; hash: string }[];
  /** Configured routes first, in config order, then discovered routes nobody placed. */
  roots: MapNode[];
  skipped: { what: string; reason: string; source?: MapSource }[];
  notes: string[];
}

export interface MapFile {
  version: 1;
  project: string;
  targets: Record<string, MapTarget>;
}

export function mapPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "map.json");
}

/** The map, or null when there is none, it cannot be read, or a future version wrote it. */
export async function loadMap(resolved: ResolvedConfig): Promise<MapFile | null> {
  const path = mapPath(resolved);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as MapFile;
    if (parsed.version !== 1 || typeof parsed.targets !== "object" || parsed.targets === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, value);
}

export async function saveMap(resolved: ResolvedConfig, file: MapFile): Promise<void> {
  await withStateLock(resolved, "map", async () => saveFile(mapPath(resolved), file));
}

/** Read, mutate, write, under the map lock: what the walk uses to stamp a node. */
export async function updateMap<T>(
  resolved: ResolvedConfig,
  mutate: (file: MapFile) => T | Promise<T>,
): Promise<{ file: MapFile; result: T }> {
  return withStateLock(resolved, "map", async () => {
    const file = (await loadMap(resolved)) ?? { version: 1 as const, project: resolved.project, targets: {} };
    const result = await mutate(file);
    await saveFile(mapPath(resolved), file);
    return { file, result };
  });
}

/**
 * Every node under the roots, pre-order, with the nearest route at or above
 * it: the route a state node's shots are filed under.
 */
export function walkNodes(
  roots: MapNode[],
  fn: (node: MapNode, routeAncestor: MapNode, depth: number, parent: MapNode | null) => void,
): void {
  const visit = (node: MapNode, routeAncestor: MapNode | null, depth: number, parent: MapNode | null): void => {
    const route = node.kind === "route" ? node : routeAncestor;
    // A state with no route above it has nowhere to file; the parser never
    // writes one, and a hand-edited file that does is skipped rather than
    // guessed at.
    if (!route) return;
    fn(node, route, depth, parent);
    for (const child of node.children ?? []) visit(child, route, depth + 1, node);
  };
  for (const root of roots) visit(root, null, 0, null);
}

/** The route a state is filed under, and the state axis of a node's shots. */
export function screenAxes(node: MapNode, routeAncestor: MapNode): { route: string; state: string } {
  return { route: routeAncestor.path ?? routeAncestor.id, state: node.kind === "route" ? "rest" : node.id };
}

/** The node whose shots carry these axes, or undefined. */
export function nodeByScreen(map: MapFile, target: string, route: string, state: string): MapNode | undefined {
  const t = map.targets[target];
  if (!t) return undefined;
  let found: MapNode | undefined;
  walkNodes(t.roots, (node, routeAncestor) => {
    if (found) return;
    const axes = screenAxes(node, routeAncestor);
    if (axes.route === route && axes.state === state) found = node;
  });
  return found;
}

/**
 * Carry what the walk learned across a re-scan: a node that is still there
 * (same route, same id) keeps its `walk`; one the scan dropped loses it.
 */
export function carryWalk(previous: MapTarget | undefined, next: MapTarget): void {
  if (!previous) return;
  const learned = new Map<string, MapWalk>();
  walkNodes(previous.roots, (node, routeAncestor) => {
    if (node.walk) {
      const axes = screenAxes(node, routeAncestor);
      learned.set(`${axes.route}|${axes.state}`, node.walk);
    }
  });
  walkNodes(next.roots, (node, routeAncestor) => {
    const axes = screenAxes(node, routeAncestor);
    const walk = learned.get(`${axes.route}|${axes.state}`);
    if (walk) node.walk = walk;
  });
}
