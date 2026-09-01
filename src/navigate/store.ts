/**
 * Navigation discovery's two files, and the shapes both sides agree on.
 *
 * The harvest (what capture found rendered on a route) lives with the
 * evidence: `.lookout/evidence/navigation-harvest.json`. The plan (what the
 * plan-navigation skill decided to actuate) lives at
 * `.lookout/navigation.json`, because it is adjudicated project data the way
 * the backlog is, not a capture artifact.
 *
 * State names in a plan are model output headed for filenames and fingerprint
 * axes, so this module owns the one validation both consumers apply: names a
 * plan carries that fail it, or that collide with a config recipe (the
 * hand-written recipe always wins), simply do not exist as far as capture,
 * scope, and pruning are concerned.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceDir, lookoutDir } from "../config.js";
import type { ResolvedConfig } from "../types.js";

export interface Affordance {
  /** Stable within one harvest: "a1", "a2", ... in document order. */
  id: string;
  tag: string;
  role: string;
  /** Accessible name, truncated to 80 chars. */
  name: string;
  /** Best stable selector the harvester could derive. */
  selector: string;
  /** Resolved absolute href for links, else null. */
  href: string | null;
  inForm: boolean;
  submit: boolean;
  box: { x: number; y: number; w: number; h: number };
}

export interface RouteHarvest {
  /** sha256-12 of the sorted normalized inventory; the staleness key. */
  signature: string;
  harvestedAt: string;
  affordances: Affordance[];
}

export type NavOutcome = "overlay" | "in-page-change" | "navigation";
export type NavRisk = "safe" | "destructive" | "session-destructive";

/**
 * How a plan remembers which control it meant. The skill replies with
 * per-harvest ids ("a1"); the plan writer resolves them into this identity so
 * a later capture, whose fresh harvest numbers everything differently, can
 * still find the control (selector first, role+name as the fallback).
 */
export interface AffordanceRef {
  selector: string;
  role: string;
  name: string;
  href: string | null;
}

export interface PlannedState {
  /** Becomes the shot's state axis; validated by validStateName. */
  name: string;
  affordance: AffordanceRef;
  outcome: NavOutcome;
  /** Metadata: orders execution (risky last), never blocks it. */
  risk: NavRisk;
  why: string;
}

export interface PlannedCheck {
  affordance: AffordanceRef;
  /** Same-origin path the link claims to lead to, when the href states one. */
  expectedPath?: string;
}

export interface RoutePlan {
  /** The harvest signature this plan was made against. */
  signature: string;
  plannedAt: string;
  skillVersion: number;
  states: PlannedState[];
  checks: PlannedCheck[];
  skipped: { affordance: string; reason: string }[];
  /** Same-origin destinations not in the config; surfaced, never auto-added. */
  suggestions: { path: string; label: string }[];
}

/** Both files key routes the way view groups do, minus the state axis. */
export function routeKey(target: string, route: string): string {
  return `${target}|${route}`;
}

export interface HarvestFile {
  version: 1;
  routes: Record<string, RouteHarvest>;
}

export interface NavigationFile {
  version: 1;
  routes: Record<string, RoutePlan>;
}

export function harvestPath(resolved: ResolvedConfig): string {
  return join(evidenceDir(resolved), "navigation-harvest.json");
}

export function navigationPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "navigation.json");
}

const EMPTY = { version: 1 as const, routes: {} };

async function loadFile<T extends { version: 1 }>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, "utf8")) as T;
  if (parsed.version !== 1) return null; // future versions rebuild from scratch
  return parsed;
}

async function saveFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export async function loadHarvests(resolved: ResolvedConfig): Promise<HarvestFile> {
  return (await loadFile<HarvestFile>(harvestPath(resolved))) ?? { ...EMPTY, routes: {} };
}

export async function saveHarvests(resolved: ResolvedConfig, file: HarvestFile): Promise<void> {
  await saveFile(harvestPath(resolved), file);
}

export async function loadPlans(resolved: ResolvedConfig): Promise<NavigationFile> {
  return (await loadFile<NavigationFile>(navigationPath(resolved))) ?? { ...EMPTY, routes: {} };
}

export async function savePlans(resolved: ResolvedConfig, file: NavigationFile): Promise<void> {
  await saveFile(navigationPath(resolved), file);
}

/**
 * A synthesized state name must survive the unslugged filename
 * (`<state>--<ff>-<scheme>.png`), the shot id, and the fingerprint, so the
 * gate is strict: kebab-case, 2-40 chars, and never the reserved "rest".
 */
export function validStateName(name: string): boolean {
  return name !== "rest" && /^[a-z][a-z0-9-]{1,39}$/.test(name);
}

/**
 * Which synthesized states currently exist per route, for scope and pruning:
 * a shot whose state a plan still names is configured intent, the way a
 * route's declared `states` are. Invalid names and names a config recipe
 * already owns are excluded here for the same reason execution drops them:
 * a state this index admits that capture would never produce is a ghost that
 * pruning could then never retire.
 */
export async function plannedStateIndex(
  resolved: ResolvedConfig,
): Promise<Map<string, Set<string>>> {
  const plans = await loadPlans(resolved);
  const recipeNames = new Set(Object.keys(resolved.config.states ?? {}));
  const index = new Map<string, Set<string>>();
  for (const [key, plan] of Object.entries(plans.routes)) {
    const names = plan.states
      .map((s) => s.name)
      .filter((n) => validStateName(n) && !recipeNames.has(n));
    if (names.length > 0) index.set(key, new Set(names));
  }
  return index;
}
