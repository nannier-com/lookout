/**
 * The screen mapper's reply as a tree: the node checks of parse-node.ts,
 * plus everything that is only wrong in relation to other nodes. Duplicate
 * routes, a configured route nested under another, a route under itself, a
 * state name used twice under one route, and the caps. Every drop is a note;
 * a fabricated citation is counted apart, because that is the one kind of
 * drop `self-heal` should see.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { PLATFORMS, type PlatformKind } from "../types.js";
import { hashText } from "../design/conformance-cache.js";
import { checkNode, normalizeRoute, riskRank, type ParseContext, type ParseTarget } from "./parse-node.js";
import type { MapNode, MapSource, MapTarget } from "./store.js";

export interface ParsedTarget {
  roots: MapNode[];
  skipped: MapTarget["skipped"];
  notes: string[];
  /** Citations that named a file or a symbol that is not there. */
  fabricated: number;
}

export interface ParsedReply {
  targets: Record<string, ParsedTarget>;
  /** Repo-relative, sorted, hashed: the files the reply said it opened and that exist. */
  examined: { path: string; hash: string }[];
  notes: string[];
}

function childrenOf(raw: unknown): unknown[] {
  const r = raw as Record<string, unknown>;
  return Array.isArray(r?.children) ? r.children : [];
}

/** Siblings in walk order: safe, then destructive, then session-destructive; stable within a band. */
function orderSiblings(nodes: MapNode[]): MapNode[] {
  return nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => riskRank(a.n.risk) - riskRank(b.n.risk) || a.i - b.i)
    .map((x) => x.n);
}

/**
 * Drop discovered nodes beyond the screen cap, breadth first, so a fifth
 * dialog goes before a second route. A configured route is never dropped:
 * the config is the operator's declared intent, and a project with more
 * routes than the cap has said so; the cap bounds what the map adds.
 */
function capScreens(roots: MapNode[], max: number, configured: ReadonlySet<string>): number {
  const queue: MapNode[] = [...roots];
  const kept = new Set<MapNode>();
  let added = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    const free = n.kind === "route" && n.path !== undefined && configured.has(n.path) && roots.includes(n);
    if (free || added < max) {
      kept.add(n);
      if (!free) added++;
      queue.push(...n.children);
    }
  }
  let dropped = 0;
  const prune = (nodes: MapNode[]): MapNode[] =>
    nodes.filter((n) => {
      if (!kept.has(n)) {
        dropped += 1 + countNodes(n.children);
        return false;
      }
      n.children = prune(n.children);
      return true;
    });
  const survivors = prune(roots);
  roots.length = 0;
  roots.push(...survivors);
  return dropped;
}

function countNodes(nodes: MapNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

function parseTarget(raw: unknown, ctx: ParseContext, target: ParseTarget): ParsedTarget {
  const notes: string[] = [];
  let fabricated = 0;
  const configured = new Map(target.routes.map((r) => [r.path, r]));
  const routePaths = new Set<string>();
  const roots: MapNode[] = [];
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const build = (
    rawNode: unknown,
    parent: MapNode | null,
    routeAncestor: MapNode | null,
    ancestors: string[],
    depth: number,
    statesUnderRoute: Set<string>,
  ): MapNode | null => {
    const checked = checkNode(rawNode, ctx, target, parent ? { risk: parent.risk, platforms: parent.platforms } : null);
    if (!checked.ok) {
      notes.push(`dropped: ${checked.reason}`);
      if (checked.fabricated) fabricated++;
      return null;
    }
    const node = checked.node;
    if (node.kind === "route") {
      const path = node.path!;
      if (parent && configured.has(path)) {
        notes.push(`dropped: ${path} is a configured route and already a root`);
        return null;
      }
      if (ancestors.includes(path)) {
        notes.push(`dropped: ${path} is nested under itself`);
        return null;
      }
      if (routePaths.has(path)) {
        notes.push(`dropped: duplicate route ${path}`);
        return null;
      }
      if (!parent) node.open = null;
      routePaths.add(path);
    } else {
      if (!routeAncestor) {
        notes.push(`dropped: state "${node.id}" has no route above it`);
        return null;
      }
      if (statesUnderRoute.has(node.id)) {
        notes.push(`dropped: state "${node.id}" is used twice under ${routeAncestor.path}`);
        return null;
      }
      statesUnderRoute.add(node.id);
    }
    if (depth >= ctx.limits.maxDepth && childrenOf(rawNode).length > 0) {
      notes.push(`pruned: ${countRaw(childrenOf(rawNode))} node(s) below ${node.id} are past the depth cap (${ctx.limits.maxDepth})`);
    } else {
      const nextRoute = node.kind === "route" ? node : routeAncestor;
      const nextStates = node.kind === "route" ? new Set<string>() : statesUnderRoute;
      const children: MapNode[] = [];
      for (const child of childrenOf(rawNode)) {
        const built = build(child, node, nextRoute, [...ancestors, ...(node.path ? [node.path] : [])], depth + 1, nextStates);
        if (built) children.push(built);
      }
      const ordered = orderSiblings(children);
      if (ordered.length > ctx.limits.maxChildren) {
        notes.push(`pruned: ${ordered.length - ctx.limits.maxChildren} child(ren) of ${node.id} past the cap (${ctx.limits.maxChildren})`);
      }
      node.children = ordered.slice(0, ctx.limits.maxChildren);
    }
    return node;
  };

  for (const rawNode of Array.isArray(r.screens) ? r.screens : []) {
    const kindOf = (rawNode as Record<string, unknown> | null)?.kind;
    if (kindOf === "state") {
      notes.push(`dropped: top-level state ${JSON.stringify((rawNode as Record<string, unknown>).id)} has no route above it`);
      continue;
    }
    const built = build(rawNode, null, null, [], 0, new Set());
    if (built) roots.push(built);
  }

  // Every configured route is a root, whether or not the reply placed it.
  for (const route of target.routes) {
    if (routePaths.has(route.path)) continue;
    roots.push({
      id: route.path,
      kind: "route",
      path: route.path,
      title: route.name,
      open: null,
      risk: "safe",
      platforms: ctx.fold,
      source: { path: ctx.projectDir },
      why: "configured route",
      children: [],
    });
    routePaths.add(route.path);
    notes.push(`added: configured route ${route.path} was not in the reply`);
  }
  // Configured routes first, in config order; discovered roots after, as replied.
  const configOrder = new Map(target.routes.map((route, i) => [route.path, i]));
  roots.sort((a, b) => {
    const ia = configOrder.get(a.path!) ?? Number.MAX_SAFE_INTEGER;
    const ib = configOrder.get(b.path!) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });

  const dropped = capScreens(roots, ctx.limits.maxScreens, new Set(configured.keys()));
  if (dropped > 0) notes.push(`pruned: ${dropped} node(s) past the screen cap (${ctx.limits.maxScreens})`);

  const skipped: MapTarget["skipped"] = [];
  for (const entry of Array.isArray(r.skipped) ? r.skipped : []) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.what !== "string" || typeof e.reason !== "string") continue;
    const s: MapTarget["skipped"][number] = { what: e.what.slice(0, 120), reason: e.reason.slice(0, 120) };
    const source = citedFile(e.source, ctx);
    if (source) s.source = source;
    skipped.push(s);
  }
  return { roots, skipped, notes, fabricated };
}

function countRaw(nodes: unknown[]): number {
  return nodes.reduce<number>((sum, n) => sum + 1 + countRaw(childrenOf(n)), 0);
}

/** A cited file that exists inside the repository, or null. */
function citedFile(raw: unknown, ctx: ParseContext): MapSource | null {
  const path = typeof raw === "string" ? raw : (raw as Record<string, unknown> | null)?.path;
  if (typeof path !== "string" || !path.trim()) return null;
  const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.projectDir, path);
  const rel = relative(ctx.repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return ctx.readText(abs) === null ? null : { path: abs };
}

/**
 * Hold a raw reply to the screen-map-v1 contract. Pure given `ctx.readText`,
 * so the tests can feed it junk with no subprocess and no disk.
 */
export function parseMapReply(raw: unknown, ctx: ParseContext): ParsedReply {
  const notes: string[] = [];
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const replied = { ...((typeof r.targets === "object" && r.targets !== null ? r.targets : {}) as Record<string, unknown>) };
  // A scan is one target at a time, and a reply that names its one target
  // wrongly (the example's name copied over the real one, measured on a
  // first real run) still describes the target that was scanned. Taken as
  // such, with a note; a reply naming several is held to the names.
  const keys = Object.keys(replied);
  if (ctx.targets.length === 1 && keys.length === 1 && keys[0] !== ctx.targets[0]!.name) {
    notes.push(`the reply named its target ${JSON.stringify(keys[0])}; taken as ${JSON.stringify(ctx.targets[0]!.name)}`);
    replied[ctx.targets[0]!.name] = replied[keys[0]!];
    delete replied[keys[0]!];
  }
  const targets: Record<string, ParsedTarget> = {};
  for (const target of ctx.targets) {
    targets[target.name] = parseTarget(replied[target.name], ctx, target);
  }
  for (const name of Object.keys(replied)) {
    if (!targets[name]) notes.push(`dropped: unknown target ${JSON.stringify(name)}`);
  }

  const examined: { path: string; hash: string }[] = [];
  let unknown = 0;
  const seen = new Set<string>();
  for (const entry of Array.isArray(r.examined) ? r.examined : []) {
    const cited = citedFile(entry, ctx);
    if (!cited) {
      unknown++;
      continue;
    }
    const rel = relative(ctx.repoRoot, cited.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    examined.push({ path: rel, hash: hashText(ctx.readText(cited.path) ?? "") });
  }
  examined.sort((a, b) => a.path.localeCompare(b.path));
  if (unknown > 0) notes.push(`${unknown} examined path(s) do not exist in the repository`);
  return { targets, examined, notes };
}

/** The fold as the parser filters platforms against it: every known platform the project walks. */
export function foldOf(platforms: readonly string[]): PlatformKind[] {
  return PLATFORMS.filter((p) => platforms.includes(p));
}

export { normalizeRoute };
