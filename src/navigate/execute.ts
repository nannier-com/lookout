/**
 * Deterministic execution of a cached navigation plan. No AI here: the plan
 * was written earlier (by `check`'s refresh step), this module turns it into
 * ordinary StateRecipes the capture loop runs, plus the link-verification
 * clicks that produce findings instead of shots.
 *
 * Policy (the user's choice): everything planned gets actuated, destructive
 * controls included. Risk classification orders the clicks (risky last,
 * session-killers last of all) and triggers sign-in recovery; it never
 * blocks. The only belts are structural: an entry must still exist in the
 * fresh harvest, must be on-origin, must carry a filename-safe non-colliding
 * name, and must fit the cap.
 */
import type { Page } from "playwright";
import type { DeterministicFinding, NavigationConfig, StateRecipe } from "../types.js";
import type { Affordance, AffordanceRef, PlannedState, RouteHarvest, RoutePlan } from "./store.js";
import { validStateName } from "./store.js";

export const DEFAULT_MAX_STATES = 5;
export const DEFAULT_MAX_CHECKS = 8;

/** A planned control that is invisible at the current form factor: skip, no finding. */
export class NavSkip extends Error {}

/** A planned interaction that went wrong: capture-error on the rest shot, route continues. */
export class NavStateError extends Error {}

/** Selector first (it came from the fresh harvest), role+name as the fallback. */
export function matchAffordance(ref: AffordanceRef, harvest: RouteHarvest): Affordance | null {
  return (
    harvest.affordances.find((a) => a.selector === ref.selector) ??
    harvest.affordances.find((a) => a.role === ref.role && a.name === ref.name) ??
    null
  );
}

function sameOrigin(href: string | null, routeUrl: string): boolean {
  if (!href) return true;
  try {
    return new URL(href).origin === new URL(routeUrl).origin;
  } catch {
    return false;
  }
}

/** Risky last, session-killers last of all; navigation states after in-page ones. */
function orderKey(s: PlannedState): number {
  const risk = s.risk === "session-destructive" ? 20 : s.risk === "destructive" ? 10 : 0;
  return risk + (s.outcome === "navigation" ? 1 : 0);
}

export interface SynthesizedStates {
  states: [string, StateRecipe][];
  /** State names whose click ends the session; capture re-runs signIn after them. */
  sessionDestructive: Set<string>;
  /** Navigation-outcome names: their shots show another page, so the route's design reference must not ride along. */
  suppressDesign: Set<string>;
  /** What was clicked to reach each state, and what was expected, for the shot record. */
  affordances: Map<string, { selector: string; role: string; name: string; href: string | null; outcome: string }>;
}

export function synthStates(args: {
  plan: RoutePlan;
  harvest: RouteHarvest;
  navigation: NavigationConfig;
  /** Config recipe names; a hand-written recipe always wins a name collision. */
  recipeNames: readonly string[];
  routeUrl: string;
}): SynthesizedStates {
  const cap = args.navigation.maxStatesPerRoute ?? DEFAULT_MAX_STATES;
  const survivors = args.plan.states
    .filter((s) => validStateName(s.name) && !args.recipeNames.includes(s.name))
    .map((s) => ({ planned: s, live: matchAffordance(s.affordance, args.harvest) }))
    .filter((s): s is { planned: PlannedState; live: Affordance } => s.live !== null)
    .filter((s) => sameOrigin(s.live.href, args.routeUrl))
    .sort((a, b) => orderKey(a.planned) - orderKey(b.planned))
    .slice(0, cap);

  const out: SynthesizedStates = {
    states: [],
    sessionDestructive: new Set(),
    suppressDesign: new Set(),
    affordances: new Map(),
  };
  for (const { planned, live } of survivors) {
    if (planned.risk === "session-destructive") out.sessionDestructive.add(planned.name);
    if (planned.outcome === "navigation") out.suppressDesign.add(planned.name);
    out.affordances.set(planned.name, {
      selector: live.selector,
      role: live.role,
      name: live.name,
      href: live.href,
      outcome: planned.outcome,
    });
    out.states.push([
      planned.name,
      {
        description: planned.why,
        // In-page changes keep the route's element; overlays and navigations
        // need the whole frame (portals render outside it, destinations are
        // another page entirely). No restore: the loop's reload guarantees a
        // clean rest state better than any Escape could.
        element: planned.outcome === "in-page-change" ? undefined : null,
        prepare: (page) => actuate(page, live, planned, args.routeUrl),
      },
    ]);
  }
  return out;
}

async function locate(page: Page, live: Affordance) {
  const bySelector = page.locator(live.selector).first();
  if (await bySelector.isVisible().catch(() => false)) return bySelector;
  const byRole = page
    .getByRole(live.role as Parameters<Page["getByRole"]>[0], { name: live.name, exact: true })
    .first();
  if (await byRole.isVisible().catch(() => false)) return byRole;
  return null;
}

async function actuate(
  page: Page,
  live: Affordance,
  planned: PlannedState,
  routeUrl: string,
): Promise<void> {
  const target = await locate(page, live);
  // Harvested at the widest form factor; a control a narrow layout hides is a
  // skip at that form factor, not a defect.
  if (!target) throw new NavSkip(`"${live.name}" not visible at this form factor`);
  if (planned.outcome === "navigation") {
    await Promise.all([
      page.waitForLoadState("load", { timeout: 15_000 }),
      target.click({ timeout: 5_000 }),
    ]);
    return;
  }
  await target.click({ timeout: 5_000 });
  // An overlay or in-page change that actually navigated would photograph
  // another page under this route's name: the mislabeling capture exists to
  // prevent. Query and hash moves are fine (tabs often write them).
  await page.waitForTimeout(150);
  const now = new URL(page.url());
  const expected = new URL(routeUrl);
  if (now.origin !== expected.origin || now.pathname !== expected.pathname) {
    throw new NavStateError(
      `"${live.name}" navigated to ${now.pathname} instead of changing ${planned.outcome === "overlay" ? "an overlay" : "the page in place"}`,
    );
  }
}

/**
 * Verification clicks: links the plan routed to `checks` (their destinations
 * are configured routes, already judged under their own identity at rest).
 * Each click must demonstrably work; what it must not do is produce a shot.
 */
export async function runNavChecks(args: {
  page: Page;
  plan: RoutePlan;
  harvest: RouteHarvest;
  navigation: NavigationConfig;
  routeUrl: string;
}): Promise<DeterministicFinding[]> {
  const cap = args.navigation.maxChecksPerRoute ?? DEFAULT_MAX_CHECKS;
  const findings: DeterministicFinding[] = [];
  const checks = args.plan.checks
    .map((c) => ({ check: c, live: matchAffordance(c.affordance, args.harvest) }))
    .filter((c): c is { check: (typeof args.plan.checks)[number]; live: Affordance } => c.live !== null)
    .filter((c) => sameOrigin(c.live.href, args.routeUrl))
    .slice(0, cap);

  for (const { check, live } of checks) {
    let status: number | null = null;
    const onResponse = (r: { status(): number; request(): { isNavigationRequest(): boolean } }) => {
      if (r.request().isNavigationRequest()) status = r.status();
    };
    args.page.on("response", onResponse);
    try {
      const target = await locate(args.page, live);
      if (!target) continue;
      const before = args.page.url();
      await target.click({ timeout: 5_000 }).catch(() => {});
      await args.page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      await args.page.waitForTimeout(250);
      const after = args.page.url();
      if (after === before) {
        findings.push({
          type: "dead-interaction",
          severity: "warning",
          message: `"${live.name}" (${live.href ?? live.selector}) did nothing when clicked`,
          // The selector as well as the name: a control found by its
          // accessible name alone may not be findable in the source.
          meta: { name: live.name, href: live.href, selector: live.selector, role: live.role,
            ...(check.expectedPath ? { expectedPath: check.expectedPath } : {}) },
        });
      } else if (status !== null && status >= 400) {
        findings.push({
          type: "request-failed",
          severity: "warning",
          message: `"${live.name}" led to HTTP ${status} at ${after}`,
          meta: { name: live.name, status, url: after, method: "GET", resourceType: "document" },
        });
      }
      if (after !== before) {
        await args.page.goto(args.routeUrl, { waitUntil: "load", timeout: 45_000 });
      }
    } finally {
      args.page.off("response", onResponse);
    }
  }
  return findings;
}
