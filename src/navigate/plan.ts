/**
 * Asking the plan-navigation skill what a route's affordances are worth.
 *
 * The reply is model output headed for filenames, fingerprints, and real
 * clicks in a real browser, so nothing in it is trusted: unknown affordance
 * ids, bad names, bad outcomes, and collisions are dropped loudly, caps are
 * clamped, and the dedupe rule (a navigation to an already-configured route
 * is a check, not a state) is enforced here rather than hoped for.
 *
 * Like the judge, the planner is cwd-pinned to the evidence workspace with
 * Read alone: it looks at screenshots, never at the judged repository.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractJson, invokeClaude } from "../judge/engine.js";
import { loadSkill, renderSkill } from "../skills/load.js";
import { evidenceDir } from "../config.js";
import { nowIso } from "../util.js";
import type { NavigationConfig, ResolvedConfig, ShotRecord } from "../types.js";
import { DEFAULT_MAX_CHECKS, DEFAULT_MAX_STATES } from "./execute.js";
import {
  validStateName,
  type Affordance,
  type NavOutcome,
  type NavRisk,
  type RouteHarvest,
  type RoutePlan,
} from "./store.js";

const OUTCOMES: readonly NavOutcome[] = ["overlay", "in-page-change", "navigation"];
const RISKS: readonly NavRisk[] = ["safe", "destructive", "session-destructive"];

/** The affordance list as the skill sees it: one line per control, by id. */
export function inventoryBrief(harvest: RouteHarvest): string {
  return harvest.affordances
    .map((a) => {
      const marks = [a.inForm ? "in form" : "", a.submit ? "submits" : ""].filter(Boolean);
      return (
        `- ${a.id} [${a.role}] ${JSON.stringify(a.name)}` +
        (marks.length ? ` (${marks.join(", ")})` : "") +
        (a.href ? ` -> ${a.href}` : "")
      );
    })
    .join("\n");
}

function pathnameOf(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href).pathname.replace(/\/$/, "") || "/";
  } catch {
    return null;
  }
}

/**
 * Hold a raw reply to the navigation-plan-v1 contract. Pure, so the tests can
 * feed it junk without a subprocess. Returns the plan pieces plus one note
 * per dropped or rerouted entry.
 */
export function parsePlanReply(
  raw: unknown,
  harvest: RouteHarvest,
  opts: {
    recipeNames: readonly string[];
    maxStates: number;
    maxChecks: number;
    /** Normalized pathnames of the target's configured routes. */
    configuredPaths: readonly string[];
  },
): { states: RoutePlan["states"]; checks: RoutePlan["checks"]; skipped: RoutePlan["skipped"]; notes: string[] } {
  const byId = new Map(harvest.affordances.map((a) => [a.id, a]));
  const notes: string[] = [];
  const states: RoutePlan["states"] = [];
  const checks: RoutePlan["checks"] = [];
  const skipped: RoutePlan["skipped"] = [];
  const seenNames = new Set<string>();
  const r = (raw ?? {}) as Record<string, unknown>;

  const refOf = (a: Affordance) => ({ selector: a.selector, role: a.role, name: a.name, href: a.href });

  for (const entry of Array.isArray(r.states) ? r.states : []) {
    const e = entry as Record<string, unknown>;
    const live = typeof e.affordance === "string" ? byId.get(e.affordance) : undefined;
    const name = typeof e.name === "string" ? e.name : "";
    if (!live) {
      notes.push(`state ${JSON.stringify(name || e.affordance)} dropped: unknown affordance`);
      continue;
    }
    if (!validStateName(name) || opts.recipeNames.includes(name) || seenNames.has(name)) {
      notes.push(`state ${JSON.stringify(name)} dropped: invalid, duplicate, or config-owned name`);
      continue;
    }
    const outcome = OUTCOMES.includes(e.outcome as NavOutcome) ? (e.outcome as NavOutcome) : null;
    if (!outcome) {
      notes.push(`state ${JSON.stringify(name)} dropped: unknown outcome ${JSON.stringify(e.outcome)}`);
      continue;
    }
    // The dedupe rule: a navigation whose destination is already a configured
    // route re-judges a page that is judged at rest under its own identity,
    // so it is verified instead of photographed.
    const destination = pathnameOf(live.href);
    if (outcome === "navigation" && destination && opts.configuredPaths.includes(destination)) {
      checks.push({ affordance: refOf(live), expectedPath: destination });
      notes.push(`state ${JSON.stringify(name)} rerouted to checks: ${destination} is already configured`);
      continue;
    }
    seenNames.add(name);
    states.push({
      name,
      affordance: refOf(live),
      outcome,
      risk: RISKS.includes(e.risk as NavRisk) ? (e.risk as NavRisk) : "safe",
      why: typeof e.why === "string" ? e.why.slice(0, 200) : "",
    });
  }
  if (states.length > opts.maxStates) {
    notes.push(`${states.length - opts.maxStates} state(s) beyond the cap dropped`);
    states.length = opts.maxStates;
  }

  for (const entry of Array.isArray(r.checks) ? r.checks : []) {
    const e = entry as Record<string, unknown>;
    const live = typeof e.affordance === "string" ? byId.get(e.affordance) : undefined;
    if (!live) {
      notes.push(`check ${JSON.stringify(e.affordance)} dropped: unknown affordance`);
      continue;
    }
    checks.push({
      affordance: refOf(live),
      ...(typeof e.expectedPath === "string" ? { expectedPath: e.expectedPath } : {}),
    });
  }
  if (checks.length > opts.maxChecks) {
    notes.push(`${checks.length - opts.maxChecks} check(s) beyond the cap dropped`);
    checks.length = opts.maxChecks;
  }

  for (const entry of Array.isArray(r.skipped) ? r.skipped : []) {
    const e = entry as Record<string, unknown>;
    if (typeof e.affordance === "string" && typeof e.reason === "string") {
      skipped.push({ affordance: e.affordance, reason: e.reason.slice(0, 120) });
    }
  }

  return { states, checks, skipped, notes };
}

/** Unconfigured same-origin destinations: derived from the harvest, not the model. */
export function coverageSuggestions(
  harvest: RouteHarvest,
  configuredPaths: readonly string[],
): RoutePlan["suggestions"] {
  const seen = new Set<string>();
  const out: RoutePlan["suggestions"] = [];
  for (const a of harvest.affordances) {
    const path = pathnameOf(a.href);
    if (!path || configuredPaths.includes(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, label: a.name });
  }
  return out;
}

export async function planRoute(args: {
  resolved: ResolvedConfig;
  target: string;
  route: string;
  harvest: RouteHarvest;
  /** This route's rest shots, for the planner to look at. */
  restShots: ShotRecord[];
  recipeNames: readonly string[];
  configuredPaths: readonly string[];
  navigation: NavigationConfig;
  model?: string;
}): Promise<{ plan: RoutePlan | null; costUsd: number; notes: string[] }> {
  const skill = await loadSkill(args.resolved, "plan-navigation");
  const maxStates = args.navigation.maxStatesPerRoute ?? DEFAULT_MAX_STATES;
  const maxChecks = args.navigation.maxChecksPerRoute ?? DEFAULT_MAX_CHECKS;
  const evDir = evidenceDir(args.resolved);
  const manifest = args.restShots
    .map((s) => `- shotId: ${s.id}\n  file: ${join(evDir, s.path)}\n  formFactor: ${s.formFactor}  scheme: ${s.scheme}  size: ${s.width}x${s.height}`)
    .join("\n");

  const prompt = renderSkill(skill.text, {
    project: args.resolved.project,
    target: args.target,
    route: args.route,
    routeList: args.configuredPaths.join(", ") || "(none)",
    configStates: args.recipeNames.join(", ") || "(none)",
    shotCount: String(args.restShots.length),
    manifest,
    inventory: inventoryBrief(args.harvest),
    maxStates: String(maxStates),
    maxChecks: String(maxChecks),
  });

  // The workspace exists after any capture, but the subprocess's cwd must
  // exist or the spawn itself fails with a misleading ENOENT.
  await mkdir(evDir, { recursive: true });
  const res = await invokeClaude({ prompt, cwd: evDir, model: args.model ?? "sonnet" });
  const cost = res.costUsd ?? 0;
  let raw: unknown;
  try {
    raw = extractJson(res.text);
  } catch {
    // A plan that cannot be parsed plans nothing: the route keeps its rest
    // coverage, and the next check tries again because no signature lands.
    return { plan: null, costUsd: cost, notes: ["reply was not parseable JSON; no plan written"] };
  }
  const parsed = parsePlanReply(raw, args.harvest, {
    recipeNames: args.recipeNames,
    maxStates,
    maxChecks,
    configuredPaths: args.configuredPaths,
  });
  return {
    plan: {
      signature: args.harvest.signature,
      plannedAt: nowIso(),
      skillVersion: skill.version,
      states: parsed.states,
      checks: parsed.checks,
      skipped: parsed.skipped,
      suggestions: coverageSuggestions(args.harvest, args.configuredPaths),
    },
    costUsd: cost,
    notes: parsed.notes,
  };
}
