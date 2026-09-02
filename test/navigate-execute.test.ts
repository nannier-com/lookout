// The executor's deterministic guarantees: what survives into synthesized
// states, in what order, and what the belts drop. Clicking itself is
// exercised by the real-verb fixture run; nothing here needs a browser.
import { describe, expect, test } from "bun:test";
import { matchAffordance, synthStates } from "../src/navigate/execute.js";
import type { Affordance, PlannedState, RouteHarvest, RoutePlan } from "../src/navigate/store.js";
import { deterministicToFindings } from "../src/backlog/ingest.js";
import type { CaptureReport } from "../src/types.js";

function aff(name: string, over: Partial<Affordance> = {}): Affordance {
  return {
    id: "a0",
    tag: "button",
    role: "button",
    name,
    selector: `[data-x=${JSON.stringify(name)}]`,
    href: null,
    inForm: false,
    submit: false,
    box: { x: 0, y: 0, w: 10, h: 10 },
    ...over,
  };
}

function harvest(affordances: Affordance[]): RouteHarvest {
  return { signature: "s", harvestedAt: "t", affordances };
}

function planned(name: string, target: Affordance, over: Partial<PlannedState> = {}): PlannedState {
  return {
    name,
    affordance: { selector: target.selector, role: target.role, name: target.name, href: target.href },
    outcome: "overlay",
    risk: "safe",
    why: "w",
    ...over,
  };
}

function plan(states: PlannedState[]): RoutePlan {
  return { signature: "s", plannedAt: "t", skillVersion: 1, states, checks: [], skipped: [], suggestions: [] };
}

const ROUTE_URL = "http://localhost:9/";

describe("matchAffordance", () => {
  test("selector first, role+name as fallback, null on a vanished control", () => {
    const live = aff("Open menu");
    const h = harvest([live]);
    expect(matchAffordance({ selector: live.selector, role: "x", name: "x", href: null }, h)).toBe(live);
    expect(matchAffordance({ selector: "#gone", role: "button", name: "Open menu", href: null }, h)).toBe(live);
    expect(matchAffordance({ selector: "#gone", role: "button", name: "Removed", href: null }, h)).toBeNull();
  });
});

describe("synthStates", () => {
  test("drops vanished controls, bad names, config collisions, and off-origin links", () => {
    const menu = aff("Menu");
    const away = aff("Away", { href: "https://elsewhere.example/x", role: "link", tag: "a" });
    const out = synthStates({
      plan: plan([
        planned("menu-open", menu),
        planned("gone-state", aff("Gone")), // not in the fresh harvest
        planned("Bad Name", menu),
        planned("menu-open-two", menu), // collides with a config recipe below? no: valid
        planned("config-owned", menu),
        planned("offsite", away, { outcome: "navigation" }),
      ]),
      harvest: harvest([menu, away]),
      navigation: {},
      recipeNames: ["config-owned"],
      routeUrl: ROUTE_URL,
    });
    expect(out.states.map(([n]) => n)).toEqual(["menu-open", "menu-open-two"]);
  });

  test("orders risky clicks last and session-killers last of all, then caps", () => {
    const a = aff("A"), b = aff("B"), c = aff("C"), d = aff("D"), e = aff("E");
    const out = synthStates({
      plan: plan([
        planned("sign-out", a, { risk: "session-destructive" }),
        planned("delete-row", b, { risk: "destructive" }),
        planned("goto-docs", c, { outcome: "navigation" }),
        planned("menu-open", d),
        planned("tab-two", e, { outcome: "in-page-change" }),
      ]),
      harvest: harvest([a, b, c, d, e]),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    expect(out.states.map(([n]) => n)).toEqual([
      "menu-open",
      "tab-two",
      "goto-docs",
      "delete-row",
      "sign-out",
    ]);
    expect(out.sessionDestructive).toEqual(new Set(["sign-out"]));
    expect(out.suppressDesign).toEqual(new Set(["goto-docs"]));

    const capped = synthStates({
      plan: plan([planned("s1", a), planned("s2", b), planned("s3", c)]),
      harvest: harvest([a, b, c]),
      navigation: { maxStatesPerRoute: 2 },
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    expect(capped.states).toHaveLength(2);
  });

  test("destructive entries are executable, never filtered", () => {
    const del = aff("Delete account");
    const out = synthStates({
      plan: plan([planned("delete-account", del, { risk: "destructive" })]),
      harvest: harvest([del]),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    expect(out.states.map(([n]) => n)).toEqual(["delete-account"]);
  });

  test("overlays and navigations shoot full-page; in-page changes keep the route element", () => {
    const a = aff("A"), b = aff("B"), c = aff("C");
    const out = synthStates({
      plan: plan([
        planned("overlay-x", a),
        planned("inpage-x", b, { outcome: "in-page-change" }),
        planned("nav-x", c, { outcome: "navigation" }),
      ]),
      harvest: harvest([a, b, c]),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    const byName = new Map(out.states);
    expect(byName.get("overlay-x")!.element).toBeNull();
    expect(byName.get("inpage-x")!.element).toBeUndefined();
    expect(byName.get("nav-x")!.element).toBeNull();
  });

  test("both indicator states are framed like the rest shot they are compared with", () => {
    // The read-back compares an indicator shot with its own rest shot. A
    // full-page hover against an element-cropped rest can never hash equal, so
    // hover-silent was structurally unfileable on any route with an element.
    const f = aff("Save"), h = aff("Pricing");
    const out = synthStates({
      plan: plan([
        planned("focus-save", f, { outcome: "focus" }),
        planned("hover-pricing", h, { outcome: "hover" }),
      ]),
      harvest: harvest([f, h]),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    const byName = new Map(out.states);
    expect(byName.get("focus-save")!.element).toBeUndefined();
    expect(byName.get("hover-pricing")!.element).toBeUndefined();
  });

  test("the phone skip comes from the one rule, and covers hover alone", () => {
    const f = aff("Save"), h = aff("Pricing"), o = aff("Menu");
    const out = synthStates({
      plan: plan([
        planned("focus-save", f, { outcome: "focus" }),
        planned("hover-pricing", h, { outcome: "hover" }),
        planned("menu-open", o),
      ]),
      harvest: harvest([f, h, o]),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    expect([...(out.skipAt.get("hover-pricing") ?? [])]).toEqual(["phone"]);
    expect(out.skipAt.has("focus-save")).toBe(false);
    expect(out.skipAt.has("menu-open")).toBe(false);
  });

  test("each indicator kind has its own budget, so clicks cannot crowd them out", () => {
    const many = [aff("A"), aff("B"), aff("C"), aff("D"), aff("E"), aff("F"), aff("G")];
    const out = synthStates({
      plan: plan([
        ...many.slice(0, 5).map((a, i) => planned(`click-${i}`, a)),
        planned("focus-one", many[5]!, { outcome: "focus" }),
        planned("hover-one", many[6]!, { outcome: "hover" }),
      ]),
      harvest: harvest(many),
      navigation: {},
      recipeNames: [],
      routeUrl: ROUTE_URL,
    });
    const names = out.states.map(([n]) => n);
    // Five clicks is the whole default state budget; both indicators survive it.
    expect(names.filter((n) => n.startsWith("click-"))).toHaveLength(5);
    expect(names).toContain("focus-one");
    expect(names).toContain("hover-one");
  });
});

describe("dead-interaction ingestion", () => {
  test("maps to the states category as a medium dead-control finding", () => {
    const report = {
      version: 1,
      project: "p",
      createdAt: "t",
      updatedAt: "t",
      runs: [],
      shots: [
        {
          id: "web/app/root/rest/desktop/light",
          target: "app", route: "/", routeName: "root", state: "rest",
          platform: "web", formFactor: "desktop", scheme: "light",
          path: "x.png", hash: "h", bytes: 1, width: 1, height: 1, animated: false,
          capturedAt: "t", runId: "r",
          deterministicFindings: [
            { type: "dead-interaction", severity: "warning", message: '"Pricing" did nothing when clicked' },
          ],
        },
      ],
    } as CaptureReport;
    const [f] = deterministicToFindings(report);
    expect(f!.category).toBe("states");
    expect(f!.attribute).toBe("dead-control");
    expect(f!.severity).toBe("medium");
  });
});
