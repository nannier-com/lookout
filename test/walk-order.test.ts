// The order a walk visits the map's screens in: route by route in the
// first-issue walk's order, each route's screens together in map order,
// and the selectors that narrow it refusing to match nothing.
import { describe, expect, test } from "bun:test";
import { flattenScreens, orderScreens } from "../src/check/walk-order.js";
import type { MapFile, MapNode } from "../src/map/store.js";

function node(partial: Partial<MapNode> & Pick<MapNode, "id" | "kind">): MapNode {
  return {
    title: partial.id,
    open: null,
    risk: "safe",
    platforms: ["web"],
    source: { path: "/repo/src/App.tsx" },
    why: "",
    children: [],
    ...partial,
    ...(partial.kind === "route" && !partial.path ? { path: partial.id } : {}),
  };
}

const MAP: MapFile = {
  version: 1,
  project: "app",
  targets: {
    app: {
      url: "http://localhost:1",
      mappedAt: "t",
      skillVersion: 1,
      ai: "claude-code",
      model: "m",
      signature: "s",
      examined: [],
      roots: [
        node({
          id: "/",
          kind: "route",
          title: "Home",
          children: [
            node({ id: "menu-open", kind: "state", children: [node({ id: "menu-search", kind: "state" })] }),
            node({ id: "delete", kind: "state", risk: "destructive" }),
            node({ id: "/pricing", kind: "route", title: "Pricing", platforms: ["web", "ios"], children: [node({ id: "compare", kind: "state", platforms: ["ios"] })] }),
          ],
        }),
        node({ id: "/settings", kind: "route", title: "Settings", children: [node({ id: "Bad Name", kind: "state" })] }),
      ],
      skipped: [],
      notes: [],
    },
  },
};

const finding = (route: string, status: string, severity = "high", channel = "ai") => ({ target: "app", route, status, severity, channel }) as never;

describe("flattenScreens", () => {
  test("pre-order, the state ancestors carried, platforms intersected, bad names skipped", () => {
    const { stops, skipped } = flattenScreens(MAP, ["web"]);
    expect(stops.map((s) => s.id)).toEqual(["app|/|rest", "app|/|menu-open", "app|/|menu-search", "app|/|delete", "app|/pricing|rest", "app|/settings|rest"]);
    expect(stops[2]!.chain.map((n) => n.id)).toEqual(["menu-open"]);
    expect(stops[4]!.chain).toEqual([]);
    expect(stops[4]!.platforms).toEqual(["web"]);
    expect(stops[3]!.allowDestructive).toBe(true);
    expect(stops[0]!.routeName).toBe("Home");
    expect(skipped).toEqual([
      { id: "app|/pricing|compare", reason: "no platform in this run" },
      { id: "app|/settings|Bad Name", reason: "invalid state name" },
    ]);
  });

  test("a device run sees the device screens and not the web-only ones", () => {
    const { stops } = flattenScreens(MAP, ["ios"]);
    expect(stops.map((s) => s.id)).toEqual(["app|/pricing|rest", "app|/pricing|compare"]);
  });
});

describe("orderScreens", () => {
  test("routes with open findings walk first, worst first; each route's screens stay together in map order", () => {
    const { stops } = orderScreens(MAP, [finding("/settings", "open", "high"), finding("/pricing", "open", "critical")], { platforms: ["web"] });
    expect(stops.map((s) => s.id)).toEqual(["app|/pricing|rest", "app|/settings|rest", "app|/|rest", "app|/|menu-open", "app|/|menu-search", "app|/|delete"]);
  });

  test("a state's finding rolls up to its route; a fixed route walks before everything", () => {
    const { stops } = orderScreens(MAP, [finding("/", "open", "low"), finding("/settings", "fixed")], { platforms: ["web"] });
    expect(stops.map((s) => s.route)).toEqual(["/settings", "/", "/", "/", "/", "/pricing"]);
  });

  test("--targets, --routes and --screens narrow, in the three spellings a route has, and refuse what matches nothing", () => {
    expect(orderScreens(MAP, [], { platforms: ["web"], routes: ["pricing"] }).stops.map((s) => s.id)).toEqual(["app|/pricing|rest"]);
    expect(orderScreens(MAP, [], { platforms: ["web"], routes: ["Settings"] }).stops.map((s) => s.id)).toEqual(["app|/settings|rest"]);
    expect(orderScreens(MAP, [], { platforms: ["web"], screens: ["app|/|delete", "app|/|menu-open"] }).stops.map((s) => s.id)).toEqual(["app|/|menu-open", "app|/|delete"]);
    expect(orderScreens(MAP, [], { platforms: ["web"], targets: ["app"] }).stops).toHaveLength(6);
    expect(() => orderScreens(MAP, [], { platforms: ["web"], targets: ["nope"] })).toThrow(/unknown target "nope"/);
    expect(() => orderScreens(MAP, [], { platforms: ["web"], screens: ["app|/|nope"] })).toThrow(/unknown screen/);
    expect(() => orderScreens(MAP, [], { platforms: ["web"], routes: ["/nowhere"] })).toThrow(/no mapped screens match/);
  });
});
