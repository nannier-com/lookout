// The screen map as configured intent: a route it discovered and a state it
// files under a route are in scope, kept by an unscoped capture, and can be
// named by --routes, without the config ever being edited.
import { describe, expect, test } from "bun:test";
import { resolveTargets, shotInConfig } from "../src/targets.js";
import { mergeRun } from "../src/capture/store.js";
import { configuredScope } from "../src/config-scope.js";
import { indexOf, mapAugmentedConfig, mappedIndex, resolveMappedTargets } from "../src/map/scope.js";
import { saveMap, type MapFile, type MapNode } from "../src/map/store.js";
import { tmpProject } from "./tmp-project.js";
import type { LookoutConfig, ResolvedConfig, RunRecord, ShotRecord } from "../src/types.js";

const CONFIG: LookoutConfig = {
  targets: [
    {
      name: "app",
      url: "http://localhost:1",
      query: { lang: "en" },
      routes: ["/", { path: "/settings", states: ["menu-open"] }],
    },
  ],
  states: { "menu-open": { prepare: async () => {} } },
  element: "main",
};

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

/** A map with a configured root, a discovered route under it, and states under both. */
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
          children: [
            node({ id: "filters-shown", kind: "state" }),
            // A name a hand-written recipe owns: the recipe wins, the map does not add it.
            node({ id: "menu-open", kind: "state" }),
            node({ id: "Bad Name", kind: "state" }),
            node({
              id: "/pricing",
              kind: "route",
              title: "Pricing",
              platforms: ["web"],
              children: [node({ id: "compare-plans", kind: "state" })],
            }),
          ],
        }),
      ],
      skipped: [],
      notes: [],
    },
  },
};

function shot(over: Partial<ShotRecord>): ShotRecord {
  return {
    id: `web/app/${over.route ?? "/"}/${over.state ?? "rest"}`,
    target: "app",
    route: "/",
    routeName: "root",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "light",
    path: "x.png",
    hash: "h",
    bytes: 1,
    width: 1,
    height: 1,
    animated: false,
    capturedAt: "t",
    runId: "r",
    deterministicFindings: [],
    ...over,
  } as ShotRecord;
}

function project(prefix: string, config: LookoutConfig = CONFIG): ResolvedConfig {
  return { ...tmpProject(prefix), config };
}

describe("indexOf", () => {
  test("every route node's path, and each valid state under its nearest route", () => {
    const index = indexOf(MAP, new Set(["menu-open"]));
    expect([...index.routes.get("app")!].sort()).toEqual(["/", "/pricing"]);
    expect([...index.states.get("app|/")!]).toEqual(["filters-shown"]);
    expect([...index.states.get("app|/pricing")!]).toEqual(["compare-plans"]);
  });
});

describe("shotInConfig with the map", () => {
  const targets = resolveTargets(CONFIG);
  const mapped = indexOf(MAP, new Set(["menu-open"]));

  test("a discovered route passes only with the index; its rest and its own states pass", () => {
    expect(shotInConfig(shot({ route: "/pricing" }), targets)).toBe(false);
    expect(shotInConfig(shot({ route: "/pricing" }), targets, undefined, mapped)).toBe(true);
    expect(shotInConfig(shot({ route: "/pricing", state: "compare-plans" }), targets, undefined, mapped)).toBe(true);
    expect(shotInConfig(shot({ route: "/pricing", state: "filters-shown" }), targets, undefined, mapped)).toBe(false);
  });

  test("a mapped state passes under its route and not under another; a bad name never does", () => {
    expect(shotInConfig(shot({ route: "/", state: "filters-shown" }), targets, undefined, mapped)).toBe(true);
    expect(shotInConfig(shot({ route: "/settings", state: "filters-shown" }), targets, undefined, mapped)).toBe(false);
    expect(shotInConfig(shot({ route: "/", state: "Bad Name" }), targets, undefined, mapped)).toBe(false);
  });

  test("the config's own answers stand, and native shots still always pass", () => {
    expect(shotInConfig(shot({ route: "/settings", state: "menu-open" }), targets, undefined, mapped)).toBe(true);
    expect(shotInConfig(shot({ route: "/gone" }), targets, undefined, mapped)).toBe(false);
    expect(shotInConfig(shot({ platform: "ios", route: "/gone" }), targets, undefined, mapped)).toBe(true);
  });
});

describe("the predicate reads the map from disk", () => {
  test("configuredScope admits mapped routes and states once the file exists", async () => {
    const r = project("lookout-map-scope-");
    const before = await configuredScope(r);
    expect(before({ platform: "web", target: "app", route: "/pricing", state: "rest" })).toBe(false);
    await saveMap(r, MAP);
    const after = await configuredScope(r);
    expect(after({ platform: "web", target: "app", route: "/pricing", state: "rest" })).toBe(true);
    expect(after({ platform: "web", target: "app", route: "/", state: "filters-shown" })).toBe(true);
    expect(after({ platform: "web", target: "app", route: "/", state: "gone-state" })).toBe(false);
  });

  test("map.enabled false switches the map off for scope, whatever is on disk", async () => {
    const r = project("lookout-map-off-", { ...CONFIG, map: { enabled: false } });
    await saveMap(r, MAP);
    expect(await mappedIndex(r)).toBeUndefined();
    const scope = await configuredScope(r);
    expect(scope({ platform: "web", target: "app", route: "/pricing", state: "rest" })).toBe(false);
  });
});

describe("the unscoped capture keeps what the map names", () => {
  const run: RunRecord = {
    id: "r2", kind: "web", startedAt: "t", finishedAt: "t", flags: {}, failures: [], skips: [],
  };

  test("mapped-route and mapped-state shots survive the prune; a state the map stopped naming does not", async () => {
    const r = project("lookout-map-prune-");
    await mergeRun(r, { ...run, id: "r1" }, [
      shot({ route: "/pricing", id: "web/app/pricing/rest" }),
      shot({ route: "/", state: "filters-shown", id: "web/app/root/filters-shown" }),
      shot({ route: "/", state: "stale-state", id: "web/app/root/stale-state" }),
    ]);
    const { report, pruned } = await mergeRun(r, run, [shot({ route: "/", id: "web/app/root/rest" })], {
      pruneNotIn: resolveTargets(CONFIG),
      mapped: indexOf(MAP, new Set(["menu-open"])),
    });
    expect(pruned).toBe(1);
    expect(report.shots.map((s) => s.id).sort()).toEqual([
      "web/app/pricing/rest",
      "web/app/root/filters-shown",
      "web/app/root/rest",
    ]);
  });
});

describe("resolveMappedTargets", () => {
  test("a discovered route becomes a route of its target, with the target's query and the config's element", async () => {
    const r = project("lookout-map-targets-");
    await saveMap(r, MAP);
    const [app] = await resolveMappedTargets(r);
    const pricing = app!.routes.find((x) => x.path === "/pricing");
    expect(pricing).toMatchObject({
      name: "Pricing",
      url: "http://localhost:1/pricing?lang=en",
      element: "main",
      platforms: ["web"],
      states: [],
    });
    // The config's own routes keep the config's definition.
    expect(app!.routes.find((x) => x.path === "/settings")?.states).toEqual(["menu-open"]);
    expect(app!.routes.map((x) => x.path)).toEqual(["/", "/settings", "/pricing"]);
  });

  test("--routes can name a discovered route by path or by title", async () => {
    const r = project("lookout-map-filter-");
    await saveMap(r, MAP);
    expect((await resolveMappedTargets(r, undefined, ["/pricing"]))[0]!.routes.map((x) => x.path)).toEqual(["/pricing"]);
    expect((await resolveMappedTargets(r, undefined, ["Pricing"]))[0]!.routes.map((x) => x.path)).toEqual(["/pricing"]);
  });

  test("useMap false, or map.enabled false, is the config alone", async () => {
    const r = project("lookout-map-nomap-");
    await saveMap(r, MAP);
    expect((await resolveMappedTargets(r, undefined, undefined, { useMap: false }))[0]!.routes.map((x) => x.path)).toEqual([
      "/",
      "/settings",
    ]);
    const off = project("lookout-map-disabled-", { ...CONFIG, map: { enabled: false } });
    await saveMap(off, MAP);
    expect((await resolveMappedTargets(off))[0]!.routes.map((x) => x.path)).toEqual(["/", "/settings"]);
  });

  test("mapAugmentedConfig never mutates its input, and a target with no routes keeps its root", () => {
    const config: LookoutConfig = { targets: [{ name: "app", url: "http://localhost:1" }] };
    const frozen = JSON.stringify(config);
    const out = mapAugmentedConfig(config, MAP);
    expect(JSON.stringify(config)).toBe(frozen);
    expect(out.targets[0]!.routes).toEqual(["/", { path: "/pricing", name: "Pricing", platforms: ["web"] }]);
    // A target the map does not know is handed back as it was.
    const other: LookoutConfig = { targets: [{ name: "other", url: "http://localhost:2" }] };
    expect(mapAugmentedConfig(other, MAP).targets[0]).toBe(other.targets[0]);
  });
});
