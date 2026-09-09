// A check with no map is exactly the check there was. The gate says no for
// --no-map, for --no-capture (nothing to reach), for a zero-config run, and
// for a project with no map and no consent to scan for one.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mapToWalk } from "../src/check/walk-gate.js";
import { saveMap, type MapFile } from "../src/map/store.js";
import type { ResolvedConfig } from "../src/types.js";
import { tmpProject } from "./tmp-project.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const silent = (): void => {};
const parsed = (flags: Record<string, string | boolean>) => ({ positionals: [], flags });

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
      roots: [{ id: "/", kind: "route", path: "/", title: "Home", open: null, risk: "safe", platforms: ["web"], source: { path: "/repo" }, why: "", children: [] }],
      skipped: [],
      notes: [],
    },
  },
};

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
});

describe("mapToWalk", () => {
  test("no map and no consent: the matrix, with a hint", async () => {
    const r = tmpProject("lookout-gate-none-");
    const lines: string[] = [];
    expect(await mapToWalk(parsed({}), r, (l) => lines.push(l))).toBeNull();
    expect(lines.some((l) => /no screen map; capturing the matrix/.test(l))).toBe(true);
  });

  test("--no-map, --no-capture and a zero-config run never walk, whatever is on disk", async () => {
    const r = tmpProject("lookout-gate-off-");
    await saveMap(r, MAP);
    expect(await mapToWalk(parsed({ "no-map": true }), r, silent)).toBeNull();
    expect(await mapToWalk(parsed({ "no-capture": true }), r, silent)).toBeNull();
    const zero: ResolvedConfig = { ...r, configPath: null };
    expect(await mapToWalk(parsed({}), zero, silent)).toBeNull();
  });

  test("a map on disk is walked, with the reach layer's real seams", async () => {
    const r = tmpProject("lookout-gate-on-");
    await saveMap(r, MAP);
    const plan = await mapToWalk(parsed({}), r, silent);
    expect(plan?.map.targets.app?.roots).toHaveLength(1);
    expect(typeof plan?.seams.reachScreen).toBe("function");
    expect(typeof plan?.seams.replayScreen).toBe("function");
    expect(typeof plan?.seams.recordReach).toBe("function");
    // A hand-written map's signature matches nothing on disk: stale, and
    // walked anyway, which is what the walk does with a stale map.
    expect(plan?.ensured.stale.map((s) => s.target)).toEqual(["app"]);
    expect(plan?.ensured.refreshed).toEqual([]);
  });

  test("--map with no map spends the scan and walks what it wrote", async () => {
    const r = tmpProject("lookout-gate-scan-");
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    const plan = await mapToWalk(parsed({ map: true }), r, silent);
    expect(plan?.ensured.refreshed).toEqual(["app"]);
    expect(plan?.map.targets.app?.roots.length).toBeGreaterThan(0);
  });
});
