// Navigation discovery's two files: shapes round-trip, state names are held
// to the filename-safe gate, and the planned-state index only admits states
// capture would actually produce (config recipes win collisions).
import { describe, expect, test } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadHarvests,
  loadPlans,
  navigationPath,
  plannedStateIndex,
  routeKey,
  saveHarvests,
  savePlans,
  validStateName,
  type NavigationFile,
  type RoutePlan,
} from "../src/navigate/store.js";
import { tmpProject } from "./tmp-project.js";

function ref(name: string) {
  return { selector: `[data-x=${JSON.stringify(name)}]`, role: "button", name, href: null };
}

function plan(over: Partial<RoutePlan> = {}): RoutePlan {
  return {
    signature: "abc123def456",
    plannedAt: "t",
    skillVersion: 1,
    states: [],
    checks: [],
    skipped: [],
    suggestions: [],
    ...over,
  };
}

describe("state names", () => {
  test("kebab-case within 2-40 chars passes; everything else fails", () => {
    expect(validStateName("menu-open")).toBe(true);
    expect(validStateName("a1")).toBe(true);
    expect(validStateName("rest")).toBe(false); // reserved
    expect(validStateName("Menu Open")).toBe(false); // filename-hostile
    expect(validStateName("x")).toBe(false); // too short
    expect(validStateName("-leading")).toBe(false);
    expect(validStateName("a/b")).toBe(false); // would split the shot path
    expect(validStateName("a".repeat(41))).toBe(false);
  });
});

describe("the two files", () => {
  test("plans round-trip; a missing file loads empty", async () => {
    const r = tmpProject("lookout-nav-store-");
    expect((await loadPlans(r)).routes).toEqual({});
    const file: NavigationFile = {
      version: 1,
      routes: {
        [routeKey("app", "/")]: plan({
          states: [
            { name: "menu-open", affordance: ref("Menu"), outcome: "overlay", risk: "safe", why: "w" },
          ],
        }),
      },
    };
    await savePlans(r, file);
    expect(await loadPlans(r)).toEqual(file);
  });

  test("harvests round-trip independently of plans", async () => {
    const r = tmpProject("lookout-nav-harvest-");
    await saveHarvests(r, {
      version: 1,
      routes: {
        [routeKey("app", "/")]: {
          signature: "s",
          harvestedAt: "t",
          affordances: [
            {
              id: "a1", tag: "button", role: "button", name: "Menu", selector: "#menu",
              href: null, inForm: false, submit: false, box: { x: 0, y: 0, w: 10, h: 10 },
            },
          ],
        },
      },
    });
    expect((await loadHarvests(r)).routes[routeKey("app", "/")]!.affordances).toHaveLength(1);
    expect((await loadPlans(r)).routes).toEqual({});
  });

  test("an unknown version rebuilds from scratch instead of guessing", async () => {
    const r = tmpProject("lookout-nav-version-");
    const p = navigationPath(r);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify({ version: 2, routes: { k: plan() } }));
    expect((await loadPlans(r)).routes).toEqual({});
  });
});

describe("plannedStateIndex", () => {
  test("admits valid names, drops invalid ones and config-recipe collisions", async () => {
    const r = tmpProject("lookout-nav-index-");
    r.config.states = { "menu-open": { prepare: async () => {} } };
    await savePlans(r, {
      version: 1,
      routes: {
        [routeKey("app", "/")]: plan({
          states: [
            { name: "menu-open", affordance: ref("Menu"), outcome: "overlay", risk: "safe", why: "w" },
            { name: "filters-shown", affordance: ref("Filters"), outcome: "in-page-change", risk: "safe", why: "w" },
            { name: "Bad Name", affordance: ref("Bad"), outcome: "overlay", risk: "safe", why: "w" },
            { name: "rest", affordance: ref("Rest"), outcome: "overlay", risk: "safe", why: "w" },
          ],
        }),
        [routeKey("app", "/empty")]: plan(),
      },
    });
    const index = await plannedStateIndex(r);
    expect(index.get(routeKey("app", "/"))).toEqual(new Set(["filters-shown"]));
    expect(index.has(routeKey("app", "/empty"))).toBe(false);
  });
});
