// The screen map on disk: it round-trips, a missing or future file is no map,
// the walk's write-back holds the lock, and a re-scan keeps what the walk
// learned about every screen that is still there.
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  carryWalk,
  loadMap,
  mapPath,
  nodeByScreen,
  saveMap,
  screenAxes,
  updateMap,
  walkNodes,
  type MapFile,
  type MapNode,
  type MapTarget,
} from "../src/map/store.js";
import { tmpProject } from "./tmp-project.js";

function node(partial: Partial<MapNode> & Pick<MapNode, "id" | "kind">): MapNode {
  return {
    title: partial.id,
    open: null,
    risk: "safe",
    platforms: ["web"],
    source: { path: "/repo/src/App.tsx", line: 1 },
    why: "",
    children: [],
    ...partial,
    ...(partial.kind === "route" && !partial.path ? { path: partial.id } : {}),
  };
}

function target(roots: MapNode[]): MapTarget {
  return {
    url: "http://localhost:3000",
    mappedAt: "2026-09-09T00:00:00.000Z",
    skillVersion: 1,
    ai: "claude-code",
    model: "sonnet",
    signature: "abc",
    examined: [],
    roots,
    skipped: [],
    notes: [],
  };
}

function file(roots: MapNode[]): MapFile {
  return { version: 1, project: "app", targets: { app: target(roots) } };
}

const TREE = [
  node({
    id: "/",
    kind: "route",
    children: [
      node({ id: "menu-open", kind: "state", children: [node({ id: "menu-search", kind: "state" })] }),
      node({ id: "/pricing", kind: "route", children: [node({ id: "compare-plans", kind: "state" })] }),
    ],
  }),
];

describe("the map file", () => {
  test("round-trips, and is absent until written", async () => {
    const r = tmpProject("lookout-map-store-");
    expect(await loadMap(r)).toBeNull();
    await saveMap(r, file(TREE));
    const back = await loadMap(r);
    expect(back?.targets.app?.roots[0]?.children.map((c) => c.id)).toEqual(["menu-open", "/pricing"]);
  });

  test("a future version, or a file that is not a map, is no map", async () => {
    const r = tmpProject("lookout-map-version-");
    const path = mapPath(r);
    await mkdir(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, project: "app", targets: {} }));
    expect(await loadMap(r)).toBeNull();
    writeFileSync(path, "{ not json");
    expect(await loadMap(r)).toBeNull();
  });

  test("updateMap stamps a node in place, creating the file when the walk is first", async () => {
    const r = tmpProject("lookout-map-update-");
    expect(existsSync(mapPath(r))).toBe(false);
    await updateMap(r, (f) => {
      f.targets.app = target(TREE);
    });
    const { result } = await updateMap(r, (f) => {
      const n = nodeByScreen(f, "app", "/", "menu-open");
      n!.walk = { reached: true, verifiedAt: "t", shotIds: ["web/app/root/menu-open/desktop/dark"] };
      return n!.id;
    });
    expect(result).toBe("menu-open");
    expect(nodeByScreen((await loadMap(r))!, "app", "/", "menu-open")?.walk?.reached).toBe(true);
  });
});

describe("walking the tree", () => {
  test("every node comes with the nearest route above it, pre-order", () => {
    const seen: string[] = [];
    walkNodes(TREE, (n, routeAncestor, depth) => {
      const axes = screenAxes(n, routeAncestor);
      seen.push(`${depth}:${axes.route}|${axes.state}`);
    });
    expect(seen).toEqual([
      "0:/|rest",
      "1:/|menu-open",
      "2:/|menu-search",
      "1:/pricing|rest",
      "2:/pricing|compare-plans",
    ]);
  });

  test("nodeByScreen finds a state under its route and not under another", () => {
    const f = file(TREE);
    expect(nodeByScreen(f, "app", "/pricing", "compare-plans")?.id).toBe("compare-plans");
    expect(nodeByScreen(f, "app", "/", "compare-plans")).toBeUndefined();
    expect(nodeByScreen(f, "app", "/pricing", "rest")?.kind).toBe("route");
    expect(nodeByScreen(f, "other", "/", "rest")).toBeUndefined();
  });

  test("a state with no route above it is skipped rather than guessed at", () => {
    const seen: string[] = [];
    walkNodes([node({ id: "orphan", kind: "state" })], (n) => seen.push(n.id));
    expect(seen).toEqual([]);
  });
});

describe("carryWalk", () => {
  test("keeps the walk of every screen still in the map, by route and id, and drops the rest", () => {
    const previous = target(structuredClone(TREE));
    walkNodes(previous.roots, (n) => {
      n.walk = { reached: true, verifiedAt: `at-${n.id}` };
    });
    // The re-scan lost the menu search and moved compare-plans under a new
    // route; it keeps the menu and the pricing page.
    const next = target([
      node({
        id: "/",
        kind: "route",
        children: [
          node({ id: "menu-open", kind: "state" }),
          node({ id: "/pricing", kind: "route" }),
          node({ id: "/plans", kind: "route", children: [node({ id: "compare-plans", kind: "state" })] }),
        ],
      }),
    ]);
    carryWalk(previous, next);
    const walks: Record<string, string | undefined> = {};
    walkNodes(next.roots, (n, routeAncestor) => {
      const axes = screenAxes(n, routeAncestor);
      walks[`${axes.route}|${axes.state}`] = n.walk?.verifiedAt;
    });
    expect(walks).toEqual({
      "/|rest": "at-/",
      "/|menu-open": "at-menu-open",
      "/pricing|rest": "at-/pricing",
      "/plans|rest": undefined,
      "/plans|compare-plans": undefined,
    });
  });

  test("nothing to carry when there was no map before", () => {
    const next = target(structuredClone(TREE));
    carryWalk(undefined, next);
    expect(next.roots[0]?.walk).toBeUndefined();
  });
});
