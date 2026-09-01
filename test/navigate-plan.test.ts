// The plan-navigation reply is untrusted: the parser is the belt. These
// tests hold it to the contract, round-trip the real prompt through the mock
// CLI, and pin the check-side refresh gate.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { coverageSuggestions, parsePlanReply, planRoute } from "../src/navigate/plan.js";
import { maybeRefreshNavigation } from "../src/check/navigate.js";
import { routeKey, saveHarvests, savePlans, loadPlans } from "../src/navigate/store.js";
import type { Affordance, RouteHarvest } from "../src/navigate/store.js";
import type { ShotRecord } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "mock-claude.ts");

function aff(id: string, name: string, over: Partial<Affordance> = {}): Affordance {
  return {
    id, tag: "button", role: "button", name,
    selector: `[data-x=${JSON.stringify(id)}]`,
    href: null, inForm: false, submit: false,
    box: { x: 0, y: 0, w: 10, h: 10 },
    ...over,
  };
}

const HARVEST: RouteHarvest = {
  signature: "sig000000000",
  harvestedAt: "t",
  affordances: [
    aff("a1", "Open menu"),
    aff("a2", "About us", { role: "link", tag: "a", href: "http://localhost:9/about" }),
    aff("a3", "Pricing", { role: "link", tag: "a", href: "http://localhost:9/pricing" }),
  ],
};

const OPTS = { recipeNames: [], maxStates: 5, maxChecks: 8, configuredPaths: ["/", "/pricing"] };

describe("parsePlanReply", () => {
  test("drops unknown affordances, bad names, and unknown outcomes, with notes", () => {
    const out = parsePlanReply(
      {
        states: [
          { affordance: "a1", name: "menu-open", outcome: "overlay", risk: "safe", why: "w" },
          { affordance: "a99", name: "ghost", outcome: "overlay", risk: "safe", why: "w" },
          { affordance: "a1", name: "Bad Name", outcome: "overlay", risk: "safe", why: "w" },
          { affordance: "a1", name: "rest", outcome: "overlay", risk: "safe", why: "w" },
          { affordance: "a1", name: "weird", outcome: "teleport", risk: "safe", why: "w" },
        ],
      },
      HARVEST,
      OPTS,
    );
    expect(out.states.map((s) => s.name)).toEqual(["menu-open"]);
    expect(out.notes).toHaveLength(4);
  });

  test("reroutes a navigation to a configured route into checks; keeps unconfigured ones", () => {
    const out = parsePlanReply(
      {
        states: [
          { affordance: "a3", name: "goto-pricing", outcome: "navigation", risk: "safe", why: "w" },
          { affordance: "a2", name: "goto-about", outcome: "navigation", risk: "safe", why: "w" },
        ],
      },
      HARVEST,
      OPTS,
    );
    expect(out.states.map((s) => s.name)).toEqual(["goto-about"]);
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]!.expectedPath).toBe("/pricing");
  });

  test("keeps destructive entries executable, defaults junk risk to safe, clamps caps", () => {
    const out = parsePlanReply(
      {
        states: [
          { affordance: "a1", name: "danger-one", outcome: "overlay", risk: "destructive", why: "w" },
          { affordance: "a1", name: "junk-risk", outcome: "overlay", risk: "extreme", why: "w" },
          { affordance: "a1", name: "over-cap", outcome: "overlay", risk: "safe", why: "w" },
        ],
      },
      HARVEST,
      { ...OPTS, maxStates: 2 },
    );
    expect(out.states.map((s) => s.risk)).toEqual(["destructive", "safe"]);
    expect(out.states).toHaveLength(2);
  });

  test("config-owned names are dropped: hand-written recipes win", () => {
    const out = parsePlanReply(
      { states: [{ affordance: "a1", name: "menu-open", outcome: "overlay", risk: "safe", why: "w" }] },
      HARVEST,
      { ...OPTS, recipeNames: ["menu-open"] },
    );
    expect(out.states).toHaveLength(0);
  });
});

describe("coverageSuggestions", () => {
  test("derives unconfigured same-origin destinations from the harvest, deduped", () => {
    const s = coverageSuggestions(HARVEST, ["/", "/pricing"]);
    expect(s).toEqual([{ path: "/about", label: "About us" }]);
  });
});

describe("planRoute through the mock CLI", () => {
  test("the real prompt renders, the mock's junk entry is dropped, the plan lands", async () => {
    const r = tmpProject("lookout-navplan-");
    const shot: ShotRecord = {
      id: "web/app/root/rest/desktop/light", target: "app", route: "/", routeName: "root",
      state: "rest", platform: "web", formFactor: "desktop", scheme: "light",
      path: "web/app/root/rest--desktop-light.png", hash: "h", bytes: 1, width: 10, height: 10,
      animated: false, capturedAt: "t", runId: "r", deterministicFindings: [],
    };
    const res = await planRoute({
      resolved: r, target: "app", route: "/", harvest: HARVEST, restShots: [shot],
      recipeNames: [], configuredPaths: ["/", "/pricing"], navigation: {},
    });
    expect(res.plan).not.toBeNull();
    const names = res.plan!.states.map((s) => s.name);
    expect(names).toContain("open-menu-open"); // kebab("Open menu") + "-open"
    expect(names).toContain("danger-click");
    expect(names).not.toContain("Bad Name!!");
    expect(res.plan!.signature).toBe(HARVEST.signature);
    expect(res.plan!.suggestions).toEqual([{ path: "/about", label: "About us" }]);
    expect(res.notes.length).toBeGreaterThan(0);
  });
});

describe("maybeRefreshNavigation gating", () => {
  const parsedBase = { verb: "check", args: [], positionals: [], flags: {} as Record<string, unknown> };

  async function project(withPlanSignature?: string) {
    const r = tmpProject("lookout-navgate-");
    r.config.navigation = { enabled: true };
    await saveHarvests(r, { version: 1, routes: { [routeKey("app", "/")]: HARVEST } });
    if (withPlanSignature) {
      await savePlans(r, {
        version: 1,
        routes: {
          [routeKey("app", "/")]: {
            signature: withPlanSignature, plannedAt: "t", skillVersion: 1,
            states: [], checks: [], skipped: [], suggestions: [],
          },
        },
      });
    }
    return r;
  }

  test("a stale route is re-planned on a full-scope run; the plan file updates", async () => {
    const r = await project("old-signature");
    const recaptured: string[][] = [];
    const res = await maybeRefreshNavigation({
      scope: { resolved: r, shots: [], shotsById: new Map() },
      parsed: { ...parsedBase, flags: {} },
      log: () => {},
      recapture: async (t, ro) => { recaptured.push([...t, ...ro]); },
    });
    expect(res.refreshed).toBe(1);
    expect(recaptured).toEqual([["app", "/"]]);
    expect((await loadPlans(r)).routes[routeKey("app", "/")]!.signature).toBe(HARVEST.signature);
  });

  test("a fresh plan spends nothing; --navigate forces; scoped and disabled runs skip", async () => {
    const fresh = await project(HARVEST.signature);
    const scope = { resolved: fresh, shots: [], shotsById: new Map() };
    const noop = { log: () => {}, recapture: async () => {} };
    expect((await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: {} }, ...noop })).refreshed).toBe(0);
    expect(
      (await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: { navigate: true } }, ...noop }))
        .refreshed,
    ).toBe(1);
    expect(
      (await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: { routes: "/" } }, ...noop }))
        .refreshed,
    ).toBe(0);
    fresh.config.navigation = { enabled: false };
    expect(
      (await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: { navigate: true } }, ...noop }))
        .refreshed,
    ).toBe(0);
  });

  // The ui's play button is why this case exists: it runs `check --first`,
  // which walks the application one route at a time by synthesizing
  // --targets/--routes for every stop. Skipping scoped runs outright meant
  // that button never planned a single call to action.
  test("a scoped run plans the route it is on and leaves the rest alone", async () => {
    const r = await project();
    r.config.targets[0]!.routes = ["/", "/pricing"];
    await saveHarvests(r, {
      version: 1,
      routes: { [routeKey("app", "/")]: HARVEST, [routeKey("app", "/pricing")]: HARVEST },
    });
    const recaptured: string[][] = [];
    const res = await maybeRefreshNavigation({
      scope: { resolved: r, shots: [], shotsById: new Map() },
      parsed: { ...parsedBase, flags: { first: true, targets: "app", routes: "/pricing" } },
      log: () => {},
      recapture: async (t, ro) => { recaptured.push([...t, ...ro]); },
    });
    expect(res.refreshed).toBe(1);
    expect(recaptured).toEqual([["app", "/pricing"]]);
    const plans = await loadPlans(r);
    expect(plans.routes[routeKey("app", "/pricing")]).toBeDefined();
    expect(plans.routes[routeKey("app", "/")]).toBeUndefined();
  });

  // The walk is what earns the exemption, not the scope flags it wears. A
  // caller who narrowed the run themselves still sees nothing planned, which
  // is what keeps verify-fix (scoped, never --first) free of plan calls.
  test("the same scope without the walk still plans nothing", async () => {
    const r = await project();
    r.config.targets[0]!.routes = ["/", "/pricing"];
    await saveHarvests(r, { version: 1, routes: { [routeKey("app", "/pricing")]: HARVEST } });
    const res = await maybeRefreshNavigation({
      scope: { resolved: r, shots: [], shotsById: new Map() },
      parsed: { ...parsedBase, flags: { targets: "app", routes: "/pricing" } },
      log: () => {},
      recapture: async () => {},
    });
    expect(res.refreshed).toBe(0);
    expect((await loadPlans(r)).routes[routeKey("app", "/pricing")]).toBeUndefined();
  });

  // The ui toggle's consent: one run, without the project's config having
  // committed to discovery for every run it will ever have.
  test("--navigation turns discovery on for a config that has not; --no-navigation still wins", async () => {
    const r = await project();
    delete r.config.navigation;
    const scope = { resolved: r, shots: [], shotsById: new Map() };
    const noop = { log: () => {}, recapture: async () => {} };
    expect((await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: {} }, ...noop })).refreshed)
      .toBe(0);
    expect(
      (await maybeRefreshNavigation({
        scope,
        parsed: { ...parsedBase, flags: { navigation: true, "no-navigation": true } },
        ...noop,
      })).refreshed,
    ).toBe(0);
    expect(
      (await maybeRefreshNavigation({ scope, parsed: { ...parsedBase, flags: { navigation: true } }, ...noop }))
        .refreshed,
    ).toBe(1);
  });
});
