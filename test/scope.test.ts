// Scope pinned to the current config: the report accumulates across runs,
// and shots of routes or states no longer configured must leave judging
// scope (and, on an unscoped capture, the report) instead of being paid for
// forever.
import { describe, expect, test } from "bun:test";
import { shotInConfig, resolveTargets } from "../src/targets.js";
import { mergeRun } from "../src/capture/store.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord, RunRecord } from "../src/types.js";

const CONFIG = {
  targets: [
    {
      name: "app",
      url: "http://localhost:1",
      routes: ["/", { path: "/settings", states: ["menu-open"] }],
    },
  ],
} as never;

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

describe("what still describes the config", () => {
  const targets = resolveTargets(CONFIG);

  test("configured routes and their declared states pass; rest always passes", () => {
    expect(shotInConfig(shot({ route: "/" }), targets)).toBe(true);
    expect(shotInConfig(shot({ route: "/settings", state: "menu-open" }), targets)).toBe(true);
    expect(shotInConfig(shot({ route: "/settings" }), targets)).toBe(true);
  });

  test("a removed route, an undeclared state, and an unknown target all fail", () => {
    expect(shotInConfig(shot({ route: "/gone" }), targets)).toBe(false);
    expect(shotInConfig(shot({ route: "/", state: "wizard-open" }), targets)).toBe(false);
    expect(shotInConfig(shot({ target: "other" }), targets)).toBe(false);
  });

  test("native shots are never judged by this predicate", () => {
    expect(shotInConfig(shot({ platform: "ios", route: "/gone" }), targets)).toBe(true);
  });
});

describe("the unscoped capture retires ghosts", () => {
  const run: RunRecord = {
    id: "r2", kind: "web", startedAt: "t", finishedAt: "t", flags: {}, failures: [], skips: [],
  };

  test("with pruneNotIn, off-config web shots leave the report, counted", async () => {
    const r = tmpProject("lookout-scope-prune-");
    // Seed a report holding a ghost-route shot from an earlier run.
    await mergeRun(r, { ...run, id: "r1" }, [shot({ route: "/gone", id: "web/app/gone/rest" })]);
    const targets = resolveTargets(CONFIG);
    const { report, pruned } = await mergeRun(r, run, [shot({ route: "/", id: "web/app/root/rest" })], {
      pruneNotIn: targets,
    });
    expect(pruned).toBe(1);
    expect(report.shots.map((s) => s.id)).toEqual(["web/app/root/rest"]);
  });

  test("without it (a scoped capture), nothing is pruned", async () => {
    const r = tmpProject("lookout-scope-keep-");
    await mergeRun(r, { ...run, id: "r1" }, [shot({ route: "/gone", id: "web/app/gone/rest" })]);
    const { report, pruned } = await mergeRun(r, run, [shot({ route: "/", id: "web/app/root/rest" })]);
    expect(pruned).toBe(0);
    expect(report.shots).toHaveLength(2);
  });
});
