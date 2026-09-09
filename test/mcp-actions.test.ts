// The pure half of the web driver: what an arrival remembers, when a replay
// recognises the screen it reached, which names the config forbids, and the
// shape a recording takes as a state recipe.
import { describe, expect, test } from "bun:test";
import { arrivalOf, checkArrival, excludedName, recipeFrom } from "../src/mcp/replay-web.js";
import type { RouteHarvest } from "../src/navigate/store.js";
import type { NavAction } from "../src/mcp/actions.js";

function harvest(names: string[], signature = "sig"): RouteHarvest {
  return {
    signature,
    harvestedAt: "t",
    affordances: names.map((name, i) => ({
      id: `a${i + 1}`,
      tag: "button",
      role: "button",
      name,
      selector: `#${i}`,
      href: null,
      inForm: false,
      submit: false,
      box: { x: 0, y: 0, w: 1, h: 1 },
    })),
  };
}

describe("arrivalOf and checkArrival", () => {
  test("an arrival remembers the signature and up to twelve control names", () => {
    const names = Array.from({ length: 20 }, (_, i) => `control ${i}`);
    const a = arrivalOf(harvest(names), "http://x/");
    expect(a).toMatchObject({ url: "http://x/", signature: "sig" });
    expect(a.sampleNames).toHaveLength(12);
    expect(arrivalOf(null, "http://x/")).toEqual({ url: "http://x/", sampleNames: [] });
  });

  test("the same signature passes; otherwise at least half the remembered controls must be there", () => {
    const a = arrivalOf(harvest(["Menu", "Close", "Search", "Help"]), "http://x/");
    expect(checkArrival(harvest(["anything"], "sig"), a)).toBe(true);
    expect(checkArrival(harvest(["Menu", "Close"], "other"), a)).toBe(true);
    expect(checkArrival(harvest(["Menu"], "other"), a)).toBe(false);
    expect(checkArrival(null, a)).toBe(false);
    // Nothing remembered means nothing to contradict.
    expect(checkArrival(null, undefined)).toBe(true);
    expect(checkArrival(null, { url: "http://x/", sampleNames: [] })).toBe(true);
  });
});

describe("excludedName", () => {
  test("matches accessible names by substring, case-insensitively, and ignores selector and path entries", () => {
    expect(excludedName("Sign out now", ["Sign out"])).toBe("Sign out");
    expect(excludedName("Delete", ["delete"])).toBe("delete");
    expect(excludedName("Menu", ["#danger", ".x", "/logout", "[data-testid=x]"])).toBeNull();
  });
});

describe("recipeFrom", () => {
  test("drops the open, keeps the description, and photographs full page", () => {
    const actions: NavAction[] = [
      { tool: "open", args: { path: "/" }, outcome: { url: "http://x/" }, at: "t" },
      { tool: "click", args: { affordance: { selector: "#m", role: "button", name: "Menu", href: null } }, outcome: { navigated: false }, at: "t" },
    ];
    const ctx = { targetUrl: "http://x", urlFor: (p: string) => `http://x${p}`, exclude: [], allowDestructive: false };
    const recipe = recipeFrom(actions, ctx, "the menu is open");
    expect(recipe.description).toBe("the menu is open");
    expect(recipe.element).toBeNull();
    expect(recipe.restore).toBeUndefined();
    expect(typeof recipe.prepare).toBe("function");
  });
});
